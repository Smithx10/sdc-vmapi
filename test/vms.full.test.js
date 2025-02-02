/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

// var test = require('tap').test;
var assert = require('assert-plus');
var uuid = require('libuuid');
var qs = require('querystring');
var async = require('async');
var util = require('util');
var jsprim = require('jsprim');
var vasync = require('vasync');

var common = require('./common');
var testUuid = require('./lib/uuid');
var waitForValue = common.waitForValue;

// --- Globals

var client;
var fabricNetwork;
var muuid;
var natZoneUuid;
var newUuid;
var jobLocation;
var vmLocation;
var vmCount;
var nicCount;
var pkgId;
var nicMac;

var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var CUSTOMER = common.config.ufdsAdminUuid;
var NETWORKS = null;
var ADMIN_NETWORK = null;
var EXTERNAL_NETWORK = null;
var VALID_NIC; // Create a new NIC with valid parameters for a later test
var FAKE_NETWORK_UUID = 'caaaf10c-a587-49c6-9cf6-9b0a14ba960b';
var FAKE_NETWORK_NAME = 'fakeNetworkName';
var VM_UUID = uuid.create(); // Needs to be different everytime the test runs
var CALLER = {
    type: 'signature',
    ip: '127.0.0.68',
    keyId: '/foo@joyent.com/keys/id_rsa'
};
var VM_ALIAS_BASE = 'vmapitest-full';

// --- Helpers
function makeVmAlias(id) {
    assert.string(id, 'id');
    return util.format('%s-%d-%s', VM_ALIAS_BASE, process.pid, id);
}

function checkMachine(t, vm) {
    t.ok(vm.uuid, 'uuid ' + vm.uuid);
    t.ok(vm.brand, 'brand');
    t.ok(vm.ram, 'ram');
    t.ok(vm.max_swap, 'swap');
    t.ok(vm.cpu_shares, 'cpu shares');
    t.ok(vm.max_lwps, 'lwps');
    t.ok(vm.create_timestamp, 'create timestamp');
    t.ok(vm.state, 'state');
    t.ok(vm.zfs_io_priority, 'zfs io');
    t.ok(vm.owner_uuid, 'owner uuid');

    // Question: why is quota null when the VM state is destroyed (unlike, say,
    // ram). Shouldn't this be persisted into destruction?
    if (vm.state && vm.state !== 'destroyed') {
        t.ok(vm.quota, 'disk');
    }
}


function checkJob(t, job) {
    t.ok(job.uuid, 'uuid');
    t.ok(job.name, 'name');
    t.ok(job.execution, 'execution');
    t.ok(job.params, 'params');
}

function getJobOk(t) {
    assert.object(t, 't');

    client.get(jobLocation, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
}



function waitForNicState(t, query, state, waitCallback) {
    var stop = false;
    var count = 0;
    var maxSeconds = 60;

    function getNicStatus(callback) {
        client.napi.get({
            path: '/nics',
            query: query
        }, function (err, req, res, nics) {
            if (err) {
                return callback(err);
            } else if (!nics.length || !nics[0].state) {
                // Log the state of the nics so that we know why we failed
                t.deepEqual(nics, {}, 'nics - query: ' + JSON.stringify(query));
                return callback(new Error('VM does not have valid NICs'));
            } else {
                return callback(null, nics[0].state);
            }
        });
    }

    async.doWhilst(
        function (callback) {
            getNicStatus(function (err, nicState) {
                if (err) {
                    return callback(err);
                }

                count++;
                // Assume just one NIC
                if (nicState === state) {
                    stop = true;
                    return callback();
                } else if (count === maxSeconds) {
                    stop = true;
                    return callback(new Error('Timeout waiting on NIC state ' +
                        'change from ' + nicState + ' to ' + state));
                }

                setTimeout(callback, 1000);
            });
        },
        function () { return !stop; },
        waitCallback);
}


function createOpts(path, params) {
    return {
        path: path,
        headers: {
            'x-request-id': uuid.create(),
            'x-context': JSON.stringify({
                caller: CALLER,
                params: params || {}
            })
        }
    };
}


function createTestVms(cb) {
    assert.func(cb, 'cb');

    var NUM_VMS = 3;
    var i = 0;
    var ret = {
        createdVms: 0
    };

    var VM = {
        autoboot: false,
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 128,
        quota: 10,
        customer_metadata: {},
        creator_uuid: CUSTOMER
    };

    vasync.whilst(
        function () {
            return i < NUM_VMS;
        },
        function (next) {
            var vm = jsprim.deepCopy(VM);
            vm.alias = makeVmAlias(i.toString());

            var opts = createOpts('/vms', vm);

            client.post(opts, vm, function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                assert.object(body, 'body');
                assert.uuid(body.job_uuid, 'body.job_uuid');

                var job = '/jobs/' + body.job_uuid;

                i++;
                ret.createdVms++;
                waitForValue(job, 'execution', 'succeeded', {
                    client: client
                }, next);
            });
        },
        function (err) {
            cb(err, ret);
        });
}


function destroyTestVms(cb) {
    assert.func(cb, 'cb');

    var path = '/vms?' + qs.stringify({
        alias: VM_ALIAS_BASE + '-',
        owner_uuid: CUSTOMER
    });
    var aliasBaseRegex = new RegExp('^' + VM_ALIAS_BASE + '-');
    var ret = {
        destroyedVms: 0
    };

    client.get(path, function (err, req, res, body) {
        if (err) {
            cb(err);
            return;
        }
        assert.arrayOfObject(body, 'body is Array');

        body = body.filter(function (vm) {
            return ['destroyed', 'failed'].indexOf(vm.state) === -1;
        });

        vasync.whilst(
            function () {
                return body.length > 0;
            },
            function (next) {
                var vm = body.pop();
                assert.object(vm, 'vm');
                assert.uuid(vm.uuid, 'vm.uuid');
                assert.string(vm.alias, 'vm.alias');
                assert.ok(vm.alias.match(aliasBaseRegex), 'vm.alias regex');

                var opts = createOpts('/vms/' + vm.uuid);

                client.del(opts, function (delErr, delReq, delRes, delBody) {
                    if (delErr) {
                        delErr.message = delErr.message + ' VM ' + vm.uuid;
                        next(delErr);
                        return;
                    }

                    assert.object(delBody, 'delBody');
                    assert.uuid(delBody.job_uuid, 'delBody.job_uuid');

                    var job = '/jobs/' + delBody.job_uuid;

                    waitForValue(job, 'execution', 'succeeded', {
                        client: client
                    }, function (waitForValueErr) {
                        if (waitForValueErr) {
                            next(waitForValueErr);
                            return;
                        }

                        ret.destroyedVms++;
                        next();
                    });
                });

            }, function (delVmsErr) {
                cb(delVmsErr, ret);
            });
    });
}


// --- Tests

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};


// Other tests depend on there being both an 'admin' and 'external' network.
// This test loads these and ensures we have both.
exports.napi_networks_ok = function (t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(networks, 'networks is set');
        t.ok(Array.isArray(networks), 'networks is Array');
        t.ok(networks.length > 1, 'more than 1 network found');
        NETWORKS = networks;
        var adminExtNetworks = common.extractAdminAndExternalNetwork(networks);
        ADMIN_NETWORK = adminExtNetworks.admin;
        EXTERNAL_NETWORK = adminExtNetworks.external;
        t.ok(ADMIN_NETWORK, 'admin network is ' +
            (ADMIN_NETWORK ? ADMIN_NETWORK.uuid : ADMIN_NETWORK));
        t.ok(EXTERNAL_NETWORK, 'external network is ' +
            (EXTERNAL_NETWORK ? EXTERNAL_NETWORK.uuid : EXTERNAL_NETWORK));
        t.done();
    });
};


// Create 3 test VMs for later use
exports.initialize_test_vms = function (t) {
    destroyTestVms(function (destroyErr, destroyObj) {
        common.ifError(t, destroyErr);

        if (!destroyErr) {
            assert.object(destroyObj, 'destroyObj');
            assert.number(destroyObj.destroyedVms, 'destroyObj.destroyedVms');
            t.ok(true, util.format('destroyed %d test vms',
                destroyObj.destroyedVms));
        }

        createTestVms(function (createErr, createObj) {
            common.ifError(t, createErr);

            if (!createErr) {
                assert.object(createObj, 'createObj');
                assert.number(createObj.createdVms, 'createObj.createdVms');
                t.ok(true, util.format('created %d test vms',
                    createObj.createdVms));
            }

            t.done();
        });
    });
};


//
// Ensure that we have no VMs that have 32MB of DRAM
//
// ARCHEOLOGICAL NOTE: It seems that the assumption here is that 32M is too
// small for any package, and as such this is a "safe" value to query to test
// that a search that has an empty result succeeds.
//
exports.filter_vms_empty = function (t) {
    var path = '/vms?ram=32&owner_uuid=' + CUSTOMER + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 0, 'body Array has 0 elements');
        t.done();
    });
};


exports.filter_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.ok(body.length > 0, 'body Array has more than 0 elements');
        body.forEach(function (m) {
            checkMachine(t, m);
            muuid = m.uuid;
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                pkgId = m['billing_id'];
            }
        });
        t.done();
    });
};


exports.filter_vms_advanced = function (t) {
    var query = qs.escape('(&(ram>=128)(tags=*-smartdc_type=core-*))');
    var path = '/vms?query=' + query;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.ok(body.length > 0, 'body Array has more than 0 elements');
        t.done();
    });
};


exports.filter_vms_predicate = function (t) {
    var pred  = JSON.stringify({ eq: [ 'brand', 'joyent-minimal' ] });
    var path = '/vms?predicate=' + pred + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);

        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);

        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.ok(body.length > 0, 'body Array has more than 0 elements');

        body.forEach(function (m, i) {
            t.equal(m.brand, 'joyent-minimal',
                util.format('body[%d].brand == "joyent-minimal"', i));
        });

        t.done();
    });
};


exports.filter_vms_mixed = function (t) {
    var query = qs.escape('(ram=128)');
    var pred  = JSON.stringify({ eq: [ 'brand', 'joyent-minimal' ] });
    var args  = 'owner_uuid=' + CUSTOMER + '&state=active';

    var path = '/vms?query=' + query + '&predicate=' + pred + '&' + args;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);

        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);

        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.ok(body.length > 0, 'body Array has more than 0 elements');

        body.forEach(function (m, i) {
            t.ok(m, util.format('body[%d] is set', i));
            checkMachine(t, m);
            t.equal(m.owner_uuid, CUSTOMER, 'owner_uuid');
            t.equal(m.max_physical_memory, 128, 'max_physical_memory');
            t.equal(m.brand, 'joyent-minimal', 'brand');
        });

        // Being extra safe here; if owner_uuid is ignored, then we get
        // vulnerabilities. Check with a non-existent owner_uuid:
        var badArgs = 'owner_uuid=ba4c20e0-a732-4abe-a185-8f76101e6b90';
        path = '/vms?query=' + query + '&predicate=' + pred + '&' + badArgs;

        client.get(path, function (err2, req2, res2, body2) {
            common.ifError(t, err2);

            t.equal(res2.statusCode, 200, '200 OK');
            t.ok(Array.isArray(body2), 'body is Array');
            t.equal(body2.length, 0, 'body Array is empty');

            t.done();
        });
    });
};


exports.limit_vms_ok = function (t) {
    var path = '/vms?limit=5&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 5, 'body length is 5');
        t.done();
    });
};


exports.head_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER + '&state=active';
    client.head(path, function (err, req, res) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count'],
            'x-joyent-resource-count header');
        vmCount = res.headers['x-joyent-resource-count'];
        t.done();
    });
};


exports.offset_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&offset=2&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count'],
            'x-joyent-resource-count header');
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, vmCount - 2, 'body length');
        t.done();
    });
};


exports.offset_vms_at_end = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&offset=' + vmCount + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 0, 'body is empty');
        t.done();
    });
};


exports.offset_vms_beyond = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&offset=' + vmCount + 5 + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 0, 'body is empty');
        t.done();
    });
};


exports.offset_fields_vms_ok = function (t) {
    // Currently we get lucky because the dhcpd0 and assets0 zones
    // are 128MBs zones
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&fields=uuid,alias&offset=1&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, vmCount - 1, 'body length');
        // TODO: this should not depend on the number of VMs, instead
        // we should create a known specific number of VMs as a setup step
        // for this test. Thus we would know that we have at least one VM
        // in the response
        if (body.length > 0) {
            t.notStrictEqual(body[0].uuid, undefined);
            t.notStrictEqual(body[0].alias, undefined);
            t.strictEqual(body[0].ram, undefined);
        }
        t.done();
    });
};


exports.offset_fields_vms_beyond = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&fields=uuid,alias&offset=' + vmCount + 5 + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 0, 'body is empty');
        t.done();
    });
};


exports.get_vm_not_found = function (t) {
    var nouuid = uuid.create();
    var path = '/vms/' + nouuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404, '404 Not Found');
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.get_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.done();
    });
};


exports.head_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER + '&state=active';
    client.head(path, function (err, req, res) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm_not_ok = function (t) {
    client.post('/vms', { owner_uuid: CUSTOMER },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409, '409 Conflict');
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm_locality_not_ok = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER,
        locality: { 'near': 'asdasd' }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.equal(res.statusCode, 409, '409 Conflict');
        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid VM parameters',
            errors: [ {
                field: 'locality',
                code: 'Invalid',
                message: 'locality contains malformed UUID'
            } ]
        });
        t.done();
    });
};


exports.create_vm_tags_not_ok = function (t) {
    function callVmapi(tags, expectedErr, next) {
        var vm = {
            owner_uuid: CUSTOMER,
            image_uuid: IMAGE,
            networks: [ { uuid: ADMIN_NETWORK.uuid } ],
            brand: 'joyent-minimal',
            billing_id: '00000000-0000-0000-0000-000000000000',
            cpu_cap: 100,
            ram: 64,
            quota: 10,
            creator_uuid: CUSTOMER,
            tags: tags
        };

        var opts = createOpts('/vms', vm);
        client.post(opts, vm, function (err, req, res, body) {
            t.ok(err, 'expecting: ' + expectedErr);
            t.equal(err.restCode, 'ValidationFailed', 'err.restCode');
            t.equal(err.message, 'Invalid VM parameters', 'err.message');
            t.equal(res.statusCode, 409, '409 Conflict');

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid VM parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    function checkBadTritonTag(next) {
        var msg = 'Unrecognized special triton tag "triton.foo"';
        callVmapi({ 'triton.foo': true }, msg, next);
    }

    function checkBadTritonTagType1(next) {
        var msg = 'Triton tag "triton.cns.services" value must be a string: ' +
            'true (boolean)';
        callVmapi({ 'triton.cns.services': true }, msg, next);
    }

    function checkBadTritonTagType2(next) {
        var msg = 'Triton tag "triton.cns.disable" value must be a boolean: ' +
            '"true" (string)';
        callVmapi({ 'triton.cns.disable': 'true' }, msg, next);
    }

    function checkBadTritonDNS(next) {
        var msg = 'invalid "triton.cns.services" tag: Expected DNS name ' +
            'but "$" found.';
        callVmapi({ 'triton.cns.services': 'foo,$#foo.bar' }, msg, next);
    }

    async.series([
        checkBadTritonTag, checkBadTritonTagType1, checkBadTritonTagType2,
        checkBadTritonDNS
    ], function () {
        t.done();
    });
};


exports.create_vm_with_unknown_network = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: FAKE_NETWORK_UUID } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.ok(err, 'error set');
        t.equal(err.restCode, 'UnprocessableEntityError', 'err.restCode');
        t.equal(res.statusCode, 422, '422 UnprocessableEntityError');

        t.deepEqual(body, {
            code: 'UnprocessableEntityError',
            message: 'No such Network or Pool with id/name: "' +
                FAKE_NETWORK_UUID + '"'
        });

        t.done();
    });
};


exports.create_vm_with_unknown_network_name = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { name: FAKE_NETWORK_NAME } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.ok(err, 'error set');
        t.equal(err.restCode, 'UnprocessableEntityError', 'err.restCode');
        t.equal(res.statusCode, 422, '422 UnprocessableEntityError');

        t.deepEqual(body, {
            code: 'UnprocessableEntityError',
            message: 'No such Network or Pool with id/name: "' +
                FAKE_NETWORK_NAME + '"'
        });

        t.done();
    });
};

// Test that pre-provisioned NICs get cleaned up properly (TRITON-394)
exports.create_vm_provision_failure = function (t) {
    var vm = {
        alias: makeVmAlias(testUuid.generateShortUuid()),
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 32,
        internal_metadata: {
            force_provision_failure: true
        },
        quota: 10,
        creator_uuid: CUSTOMER
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function onCreateVm(err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        newUuid = body.vm_uuid;
        t.ok(true, 'vmUuid: ' + newUuid);
        vmLocation = '/vms/' + newUuid;

        t.done();
    });
};

exports.get_eventual_fail_job = function (t) {
    getJobOk(t);
};

exports.wait_provisioned_job_failed = function (t) {
    waitForValue(jobLocation, 'execution', 'failed', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};

// verify create_vm_provision_failure VM has no NICs
exports.failed_provision_has_no_nics = function (t) {
    var vmUuid = vmLocation.split('/')[2];

    var params = {
        belongs_to_uuid: vmUuid,
        belongs_to_type: 'zone',
        owner_uuid: CUSTOMER
    };

    client.napi.get({path: '/nics', query:  params},
        function onGetNics(err, req, res, nics) {
        common.ifError(t, err);
        t.ok(Array.isArray(nics), 'nics array');
        t.equal(nics.length, 0, 'failed provision has no nics');
        t.done();
    });
};

exports.create_vm = function (t) {
    var md = {
        foo: 'bar',
        nonascii: 'TRITON-635 test with non-ascii ¥ string',
        credentials: JSON.stringify({ 'user_pw': '12345678' })
    };

    var vm = {
        alias: makeVmAlias(testUuid.generateShortUuid()),
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        customer_metadata: md,
        creator_uuid: CUSTOMER,
        locality: {
            strict: false,
            far: [ '00000000-0000-0000-0000-000000000001' ]
        }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        newUuid = body.vm_uuid;
        vmLocation = '/vms/' + newUuid;

        // GetVm should not fail after provision has been queued
        client.get(vmLocation, function (err2, req2, res2, body2) {
            common.ifError(t, err2);
            t.equal(res2.statusCode, 200, '200 OK');
            common.checkHeaders(t, res2.headers);
            t.ok(body2, 'provisioning vm ok');

            client.post(vmLocation, { action: 'stop' },
              function (err3, req3, res3, body3) {
                t.equal(res3.statusCode, 409, 'cannot stop unprovisioned VM');
                common.checkHeaders(t, res3.headers);
                t.done();
            });
        });
    });
};


exports.get_job = function (t) {
    getJobOk(t);
};


exports.wait_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_create_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_locality_in_internal_metadata = function (t) {
    client.get(vmLocation, function getVm(err, req, res, body) {
        common.ifError(t, err);

        t.deepEqual(JSON.parse(body.internal_metadata.locality), {
            strict: false,
            far: [ '00000000-0000-0000-0000-000000000001' ]
        });

        t.done();
    });
};


exports.stop_vm = function (t) {
    var params = {
        action: 'stop'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_stopped_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_stop_vm_nics_stopped = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'stopped', function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.start_vm = function (t) {
    var params = {
        action: 'start'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_started_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_start_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.reboot_vm = function (t) {
    var params = {
        action: 'reboot'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_rebooted_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_reboot_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};

// This test exists to prevent regression of ZAPI-779 where a user could
// send a POST request without a VM UUID
exports.undefined_vm_action = function (t) {
    var params = {
        action: 'add_nics'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.equal(res.statusCode, 409, '409 Conflict');
        t.done();
    });
};


exports.add_nics_with_unknown_network = function (t) {
    var params = {
        action: 'add_nics',
        networks: [ { uuid: FAKE_NETWORK_UUID } ]
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err, 'error set');
        t.equal(err.restCode, 'UnprocessableEntityError', 'err.restCode');
        t.equal(res.statusCode, 422, '422 UnprocessableEntityError');

        t.deepEqual(body, {
            code: 'UnprocessableEntityError',
            message: 'No such Network or Pool with id/name: "' +
                FAKE_NETWORK_UUID + '"'
        });

        t.done();
    });
};


exports.add_nics_with_unknown_network_name = function (t) {
    var params = {
        action: 'add_nics',
        networks: [ { name: FAKE_NETWORK_NAME } ]
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err, 'error set');
        t.equal(err.restCode, 'UnprocessableEntityError', 'err.restCode');
        t.equal(res.statusCode, 422, '422 UnprocessableEntityError');

        t.deepEqual(body, {
            code: 'UnprocessableEntityError',
            message: 'No such Network or Pool with id/name: "' +
                FAKE_NETWORK_NAME + '"'
        });

        t.done();
    });
};


exports.create_vm_with_already_provisioned_ip = function (t) {
    var zoneUuid;
    var ips;

    client.get(vmLocation, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'got provisioned vm');

        ips = body.nics.filter(function (nic) {
            return nic.nic_tag === ADMIN_NETWORK.nic_tag;
        }).map(function (nic) {
            return nic.ip;
        });
        t.ok(ips[0], 'found ip on the admin network');

        zoneUuid = body.uuid;

        var vm = {
            alias: makeVmAlias(testUuid.generateShortUuid()),
            owner_uuid: CUSTOMER,
            image_uuid: IMAGE,
            brand: 'joyent-minimal',
            billing_id: '00000000-0000-0000-0000-000000000000',
            cpu_cap: 100,
            ram: 64,
            quota: 10,
            creator_uuid: CUSTOMER
        };

        vm.networks = [
            {
                ipv4_uuid: ADMIN_NETWORK.uuid,
                ipv4_ips: [ ips[0] ]
            }
        ];

        var opts = createOpts('/vms', vm);

        client.post(opts, vm, function (err2, req2, res2, body2) {
            t.ok(err2, 'error set');
            t.equal(err2.restCode, 'InvalidParameters', 'err.restCode');
            t.equal(res2.statusCode, 422, '409 InvalidParametersError');

            /*
             * Since this test is relying on an error from napi we are going
             * to delete the message associated with the error to not trip
             * up the test when a change in napi gets made.
             * For example: NAPI-438
             *
             * Also we check for the presence of an errors array first so we are
             * careful not to crash the entire test suite.
             */
            var modifiedBody = jsprim.deepCopy(body2);
            if (modifiedBody.errors) {
                modifiedBody.errors.forEach(function deleteMessage(error) {
                    delete error.message;
                });
            }

            t.deepEqual(modifiedBody, {
                code: 'InvalidParameters',
                message: 'Invalid parameters',
                errors: [ {
                    type: 'zone',
                    id: zoneUuid,
                    code: 'UsedBy',
                    field: 'ip'
                } ]
            }, 'expected error matches');

            t.done();
        });
    });
};


exports.add_nics_with_networks = function (t) {
    var params = {
        action: 'add_nics',
        networks: [ { uuid: EXTERNAL_NETWORK.uuid } ]
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_add_nics_with_networks = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_add_nics_with_network_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        nic_tag: EXTERNAL_NETWORK.nic_tag
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.add_nics_with_macs = function (t) {
    var params = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        owner_uuid: CUSTOMER,
        network_uuid: EXTERNAL_NETWORK.uuid,
        nic_tag: EXTERNAL_NETWORK.nic_tag,
        status: 'provisioning'
    };

    var opts = createOpts('/nics', params);

    client.napi.post(opts, params, function (err, req, res, nic) {
        common.ifError(t, err);

        VALID_NIC = nic;

        var params2 = {
            action: 'add_nics',
            macs: [ nic.mac ]
        };

        var opts2 = createOpts(vmLocation, params2);

        client.post(opts2, params2, function (err2, req2, res2, body2) {
            common.ifError(t, err2);
            t.equal(res2.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res2.headers);
            t.ok(body2, 'body2 is set');
            jobLocation = '/jobs/' + body2.job_uuid;
            t.ok(true, 'jobLocation: ' + jobLocation);
            t.done();
        });
    });
};


exports.wait_add_nics_with_macs = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_add_nics_with_macs_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        nic_tag: EXTERNAL_NETWORK.nic_tag
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.remove_nics = function (t) {
    // Get VM object to get its NICs
    client.get(vmLocation, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.ok(body.nics, 'body.nics is set');
        t.ok(Array.isArray(body.nics), 'body.nics is Array');
        t.equal(body.nics.length, 3, 'body.nics has length 3');

        var macs = body.nics.filter(function (nic) {
            return nic.nic_tag === EXTERNAL_NETWORK.nic_tag;
        }).map(function (nic) {
            return nic.mac;
        });

        t.equal(macs.length, 2, 'macs has length 2');

        var params = {
            action: 'remove_nics',
            macs: macs
        };

        var opts = createOpts(vmLocation, params);

        client.post(opts, params, function (err2, req2, res2, body2) {
            common.ifError(t, err2);
            t.equal(res2.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res2.headers);
            t.ok(body2, 'body2 is set');
            jobLocation = '/jobs/' + body2.job_uuid;
            t.ok(true, 'jobLocation: ' + jobLocation);
            t.done();
        });
    });
};


exports.wait_remove_nics = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.check_remove_nics_removed = function (t) {
    client.napi.get({
        path: '/nics',
        query: {
            belongs_to_uuid: newUuid,
            belongs_to_type: 'zone',
            nic_tag: EXTERNAL_NETWORK.nic_tag
        }
    }, function (err, req, res, nics) {
        common.ifError(t, err);
        t.equal(nics.length, 0);
        t.done();
    });
};


// Adding this test due to JPC-1045 bug, where a change to owner_uuid was
// requested with an empty owner_uuid value:
exports.change_owner_without_uuid = function (t) {
    var params = {
        action: 'update',
        owner_uuid: ''
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
          t.equal(res.statusCode, 409, '409 Conflict');
          t.done();
    });
};


exports.change_with_bad_tags = function (t) {
    function action(tags, expectedErr, next) {
        var params = {
            action: 'update',
            tags: tags
        };

        var opts = createOpts(vmLocation, params);

        t.ok(true, 'client.post expecting: ' + expectedErr);
        client.post(opts, params, function (err, req, res, body) {
            t.ok(err, 'error set');
            t.equal(err.restCode, 'ValidationFailed', 'err.restCode');
            t.equal(err.message, 'Invalid VM update parameters', 'err.message');
            t.equal(res.statusCode, 409, '409 Conflict');

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid VM update parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    function call(method, tags, expectedErr, next) {
        var path = '/vms/' + newUuid + '/tags';
        var opts = createOpts(path, tags);

        t.ok(true, util.format('client.%s  expecting: %s',
            method, expectedErr));

        client[method](opts, tags, function (err, req, res, body) {
            t.ok(err, 'error set');
            t.equal(err.restCode, 'ValidationFailed', 'err.restCode');
            t.equal(err.message, 'Invalid tag parameters', 'err.message');
            t.equal(res.statusCode, 409, '409 Conflict');

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid tag parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    var unrecognizedMsg = 'Unrecognized special triton tag "triton.foo"';
    var stringMsg = 'Triton tag "triton.cns.services" value must be a ' +
        'string: true (boolean)';
    var booleanMsg = 'Triton tag "triton.cns.disable" value must be a ' +
        'boolean: "true" (string)';
    var dnsMsg = 'invalid "triton.cns.services" tag: Expected DNS name but ' +
        '"_" found.';
    var dockerMsg1 = 'Special tag "docker:label:com.docker." not supported';
    var dockerMsg2 = 'Special tag "sdc_docker" not supported';

    function actionBadTritonTag(next) {
        action({ 'triton.foo': true }, unrecognizedMsg, next);
    }

    function actionBadTritonTagType1(next) {
        action({ 'triton.cns.services': true }, stringMsg, next);
    }

    function actionBadTritonTagType2(next) {
        action({ 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function actionBadTritonDNS(next) {
        action({ 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function actionBadReservedDockerTagType1(next) {
        action({ 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg1,
               next);
    }

    function actionBadReservedDockerTagType2(next) {
        action({ 'sdc_docker': true }, dockerMsg2, next);
    }

    function postBadTritonTag(next) {
        call('post', { 'triton.foo': true }, unrecognizedMsg, next);
    }

    function postBadTritonTagType1(next) {
        call('post', { 'triton.cns.services': true }, stringMsg, next);
    }

    function postBadTritonTagType2(next) {
        call('post', { 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function postBadTritonDNS(next) {
        call('post', { 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function postBadReservedDockerTagType1(next) {
        call('post', { 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg1,
            next);
    }

    function postBadReservedDockerTagType2(next) {
        call('post', { 'sdc_docker': true }, dockerMsg2, next);
    }

    function putBadTritonTag(next) {
        call('put', { 'triton.foo': true }, unrecognizedMsg, next);
    }

    function putBadTritonTagType1(next) {
        call('put', { 'triton.cns.services': true }, stringMsg, next);
    }

    function putBadTritonTagType2(next) {
        call('put', { 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function putBadTritonDNS(next) {
        call('put', { 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function putBadReservedDockerTagType1(next) {
        call('put', { 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg1,
            next);
    }

    function putBadReservedDockerTagType2(next) {
        call('put', { 'sdc_docker': true }, dockerMsg2, next);
    }

    async.series([
        actionBadTritonTag, actionBadTritonTagType1, actionBadTritonTagType2,
        actionBadTritonDNS, postBadTritonTag, postBadTritonTagType1,
        postBadTritonTagType2, postBadTritonDNS, putBadTritonTag,
        putBadTritonTagType1, putBadTritonTagType2, putBadTritonDNS,
        actionBadReservedDockerTagType1, actionBadReservedDockerTagType2,
        postBadReservedDockerTagType1, postBadReservedDockerTagType2,
        putBadReservedDockerTagType1, putBadReservedDockerTagType2
    ], function () {
        t.done();
    });
};


exports.list_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body');
        t.ok(!Object.keys(body).length, 'empty body');
        t.done();
    });
};


exports.add_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        role: 'database',
        group: 'deployment'
    };

    var opts = createOpts(path, query);

    client.post(opts, query, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_new_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.wait_new_tag = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.get_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER +
        '&state=active';

    client.get(path, function (err, req, res, data) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(data);
        t.equal(data, 'database');
        t.done();
    });
};


exports.delete_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_delete_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.wait_delete_tag = function (t) {
    var tags = {
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.delete_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_delete_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.wait_delete_tags = function (t) {
    waitForValue(vmLocation, 'tags', {}, {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.set_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        role: 'database',
        group: 'deployment',
        num: -1,  // test a tag number with a '-'
        mybool: true,
        withequals: 'foo=bar'  // test a tag value with '='
    };

    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_set_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.wait_set_tags = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment',
        num: -1,
        mybool: true,
        withequals: 'foo=bar'
    };

    waitForValue(vmLocation, 'tags', tags, {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.snapshot_vm = function (t) {
    var params = {
        action: 'create_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_snapshot_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.rollback_vm = function (t) {
    var params = {
        action: 'rollback_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_rollback_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.delete_snapshot = function (t) {
    var params = {
        action: 'delete_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_delete_snapshot_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.reprovision_vm = function (t) {
    var repdata = {
        action: 'reprovision',
        image_uuid: IMAGE
    };

    var opts = createOpts(vmLocation, repdata);

    client.post(opts, repdata, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_reprovision_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.destroy_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.filter_jobs_ok = function (t) {
    var path = '/jobs?task=provision&vm_uuid=' + newUuid;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 1);
        t.done();
    });
};


exports.filter_vm_jobs_ok = function (t) {
    var path = '/vms/' + newUuid + '/jobs?task=reboot';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.equal(body.length, 1);
        t.done();
    });
};


exports.get_audit = function (t) {
    client.get('/jobs?vm_uuid=' + newUuid, function (err, req, res, jobs) {
        common.ifError(t, err);

        var expectedNames = [
            'destroy', 'reprovision', 'delete-snapshot', 'rollback', 'snapshot',
            'update', 'update', 'update', 'update', 'remove-nic', 'add-nics',
            'add-nics', 'reboot', 'start', 'stop', 'provision'
        ];

        for (var i = 0; i !== expectedNames.length; i++) {
            var expectedName = expectedNames[i];
            var job = jobs[i];
            var context = job.params.context;

            t.ok(job.name.indexOf(expectedName) !== -1);
            t.ok(typeof (context.params) === 'object');
            t.deepEqual(context.caller, CALLER);
        }

        t.done();
    });
};


exports.create_nonautoboot_vm = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        autoboot: false
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
          common.ifError(t, err);
          t.equal(res.statusCode, 202, '202 Accepted');
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.get_nonautoboot_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_nonautoboot_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.change_autoboot = function (t) {
    var params = {
        action: 'update',
        autoboot: true
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_autoboot_update_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.get_nonautoboot_vm_ok = function (t) {
    var path = '/vms/' + newUuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.equal(body.state, 'stopped');
        t.done();
    });
};


exports.destroy_nonautoboot_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_nonautoboot_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


// Support for NICs that are created first and then passed into vmapi.
// For example manta-adm does this
exports.create_vm_from_existing_nics = function (t) {
    // Make sure this test is ran after we have known working parameters
    assert.object(VALID_NIC, 'VALID_NIC');

    var params = {
        owner_uuid: CUSTOMER,
        network_uuid: VALID_NIC.network_uuid,
        ip: VALID_NIC.ip,
        nic_tag: VALID_NIC.nic_tag,
        belongs_to_type: 'zone',
        belongs_to_uuid: VM_UUID,
        state: 'provisioning'
    };

    var opts = createOpts('/nics', params);

    client.napi.post(opts, params, function (err, req, res, nic) {
        common.ifError(t, err);
        t.equal(nic.ip, VALID_NIC.ip, 'ip');
        t.equal(nic.nic_tag, VALID_NIC.nic_tag, 'owner_uuid');
        t.equal(nic.network_uuid, VALID_NIC.network_uuid, 'network_uuid');
        t.equal(nic.owner_uuid, CUSTOMER, 'owner_uuid');
        t.equal(nic.state, 'provisioning', 'nic state provisioning');

        nicMac = nic.mac;

        var vm = {
            alias: 'vmapi-existing-nics-test',
            uuid: VM_UUID,
            owner_uuid: CUSTOMER,
            image_uuid: IMAGE,
            networks: [ { uuid: VALID_NIC.network_uuid } ],
            brand: 'joyent-minimal',
            billing_id: '00000000-0000-0000-0000-000000000000',
            cpu_cap: 100,
            ram: 64,
            quota: 10,
            creator_uuid: CUSTOMER
        };

        var vmOpts = createOpts('/vms', vm);

        client.post(vmOpts, vm, function (createErr, createReq, createRes,
            createBody) {
            common.ifError(t, createErr);
            t.equal(createRes.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, createRes.headers);
            t.ok(createRes.headers['workflow-api'], 'workflow-api header');
            t.ok(createBody, 'vm ok');

            jobLocation = '/jobs/' + createBody.job_uuid;
            t.ok(true, 'jobLocation: ' + jobLocation);
            newUuid = createBody.vm_uuid;
            vmLocation = '/vms/' + newUuid;
            t.done();
        });
    });
};

exports.wait_provisioned_vm_from_existing_nics = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};

exports.check_vm_from_existing_nics = function (t) {
    client.get(vmLocation, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'got provisioned vm');
        t.equal(body.nics.length, 1, 'single nic');
        t.equal(body.nics[0].ip, VALID_NIC.ip, 'found expected IP');
        t.equal(body.nics[0].mac, nicMac, 'found expected mac addr');
        t.equal(body.nics[0].nic_tag, VALID_NIC.nic_tag, 'found expected' +
            ' nic_tag');
        t.equal(body.nics[0].network_uuid, VALID_NIC.network_uuid, 'found' +
            ' expected network uuid');
        t.done();
    });
};

exports.destroy_vm_from_existing_nics = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_destroyed_vm_from_existing_nics = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.create_vm_with_package = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: pkgId
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
          common.ifError(t, err);
          t.equal(res.statusCode, 202, '202 Accepted');
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
          t.ok(true, 'jobLocation: ' + jobLocation);
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.wait_provisioned_with_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


//
// If there's not enough spare RAM on a server, and we're resizing upwards, we
// want the provision to fail. Failure should be the normal case for this
// feature, since ideally it will never work if we've done a good job of packing
// VMs.
//
exports.resize_package_up_fail = function (t) {
    //
    // NOTE: VM should have been created by:
    //
    // create_vm_with_package
    //
    // above which uses 'pkgId' set by:
    //
    // filter_vms_ok
    //
    // To the package of the first VM it could find with 128M of "ram".
    // So the VM should exist and be using 128M of DRAM.
    //

    var largeRamValue = // value is in MiB, so:
            10 * 1024 * // 10 EiB should be enough for anyone
            1024 *      // PiB
            1024 *      // TiB
            1024;       // GiB
    var largeQuotaValue = largeRamValue * 1024; // EiB->ZiB
    var pkgName = 'ginormous-vmapi-test-10EiB';

    vasync.pipeline({
        arg: {},
        funcs: [
            function _createGinormousPackage(ctx, cb) {
                client.papi.post('/packages', {
                    active: true,
                    cpu_cap: 10000,
                    description:
                        'Very large test package for VMAPI\'s vms.full.test.js',
                    max_lwps: 30000,
                    max_physical_memory: largeRamValue,
                    max_swap: largeRamValue,
                    name: pkgName,
                    quota: largeQuotaValue,
                    version: '1.0.0',
                    vcpus: 32, // the largest papi currently allows LOL
                    zfs_io_priority: 16383 // also largest papi currently allows
                }, function _onPost(err, req, res, body) {
                    common.ifError(t, err, 'POST ginormous package to PAPI');

                    if (!err) {
                        t.ok(body.uuid, 'created package uuid: ' + body.uuid);
                        t.equal(pkgName, body.name,
                            'response should be our fresh package');
                        ctx.pkgUuid = body.uuid;
                    }

                    cb(err);
                });
            }, function _resizeToGinormous(ctx, cb) {
                var params = {
                    action: 'update',
                    billing_id: ctx.pkgUuid
                };
                var opts = createOpts(vmLocation, params);

                client.post(opts, params,
                    function _onPost(err, req, res, body) {

                    var error;

                    t.ok(err, 'expected error POSTing resize');
                    t.equal(res.statusCode, 409, 'expected HTTP code 409');
                    t.equal(body.code, 'ValidationFailed',
                        'expected ValidationFailed error');
                    t.equal(body.message, 'Invalid VM update parameters',
                        'expected invalid update message');

                    error = body.errors[0];
                    t.equal(error.field, 'ram', 'error should be due to ram');
                    t.equal(error.code, 'InsufficientCapacity',
                        'error code should be InsufficientCapacity');
                    t.ok(error.message.match(
                        'Required additional RAM \\(\\d+\\) ' +
                        'exceeds the server\'s available RAM \\(-?\\d+\\)'),
                        'error message should explain additional RAM required');

                    cb();
                });
            }, function _deleteGinormousPackage(ctx, cb) {
                client.papi.del({
                    path: '/packages/' + ctx.pkgUuid + '?force=true'
                }, function _onDel(err, req, res, body) {
                    common.ifError(t, err, 'DELETE created package');

                    t.equal(204, res.statusCode, 'expected 204 from DELETE');
                    t.ok(!err, 'expected no restCode' +
                        (err ? 'got ' + err.restCode : ''));

                    cb(err);
                });
            }
        ]
    }, function pipelineComplete(err) {
        common.ifError(t, err, 'resize pipeline');
        t.done();
    });
};


exports.find_new_package_ok = function (t) {
    var path = '/vms?ram=' + 256 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body, 'body is set');
        t.ok(Array.isArray(body), 'body is Array');
        t.ok(body.length > 0, 'body Array has more than 0 elements');
        body.forEach(function (m) {
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                pkgId = m['billing_id'];
            }
        });
        t.done();
    });
};


exports.resize_package = function (t) {
    var params = { action: 'update', billing_id: pkgId };

    var opts = createOpts(vmLocation + '?force=true', params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_resize_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


// regardless of spare RAM on server, we always want resizing down to succeed
exports.resize_package_down = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;
    var smallerPkg;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        body.forEach(function (m) {
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                smallerPkg = m['billing_id'];
            }
        });

        var params = { action: 'update', billing_id: smallerPkg };

        var opts = createOpts(vmLocation, params);

        return client.post(opts, params, function (err2, req2, res2, body2) {
            common.ifError(t, err2);
            t.equal(res.statusCode, 200, '200 OK');
            jobLocation = '/jobs/' + body2.job_uuid;
            t.ok(true, 'jobLocation: ' + jobLocation);
            t.done();
        });
    });
};


exports.wait_resize_package_job_2 = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.destroy_vm_with_package = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_destroyed_with_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.provision_network_names = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { name: ADMIN_NETWORK.name } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        vmLocation = '/vms/' + body.vm_uuid;
        t.done();
    });
};


exports.wait_provision_network_names = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.destroy_provision_network_name_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.invalid_firewall_rules = function (t) {
    var errs = {
        enabled: 'Invalid rule: enabled must be a boolean',
        global: 'Invalid rule: cannot specify global rules',
        owner: 'Invalid rule: owner_uuid must be a UUID',
        rule: 'Invalid rule: rule must be a string',
        uuid: 'Invalid rule: uuid must be a UUID'
    };

    var owner = 'c5122cc9-5e58-4d99-bcb9-7ef8ccaaa46e';
    var rule = 'FROM any TO all vms ALLOW tcp PORT 80';
    var u = '4d71053b-8fd8-4042-88b2-fe10c7cc7055';

    var invalid = [
        [ 'asdf', 'Not an array' ],
        [ {}, 'Not an array' ],
        [ [ 'asdf' ], 'Not an array of objects' ],

        [ [ { } ], errs.uuid ],
        [ [ { uuid: {} } ], errs.uuid ],
        [ [ { uuid: 'asdf' } ], errs.uuid ],

        [ [ { uuid: u } ], errs.rule ],
        [ [ { uuid: u, rule: {} } ], errs.rule ],

        [ [ { uuid: u, rule: rule, global: true } ], errs.global ],

        [ [ { uuid: u, rule: rule, owner_uuid: 1 } ], errs.owner ],
        [ [ { uuid: u, rule: rule, owner_uuid: {} } ], errs.owner ],
        [ [ { uuid: u, rule: rule, owner_uuid: 'asdf' } ], errs.owner ],

        [ [ { uuid: u, rule: rule, owner_uuid: owner } ], errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: 1 } ],
            errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: 'asdf' } ],
            errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: {} } ],
            errs.enabled ]
    ];

    async.forEachSeries(invalid, function (params, cb) {
        var vm = {
            owner_uuid: CUSTOMER,
            image_uuid: IMAGE,
            networks: [ { name: ADMIN_NETWORK.uuid } ],
            brand: 'joyent-minimal',
            billing_id: '00000000-0000-0000-0000-000000000000',
            cpu_cap: 100,
            ram: 64,
            quota: 10,
            creator_uuid: CUSTOMER,
            firewall_rules: params[0]
        };

        var opts = createOpts('/vms', vm);

        client.post(opts, vm, function (err, req, res, body) {
            t.ok(err, 'error returned');
            if (err) {
                t.deepEqual(err.body, {
                    code: 'ValidationFailed',
                    message: 'Invalid VM parameters',
                    errors: [ {
                        field: 'firewall_rules',
                        code: 'Invalid',
                        message: params[1]
                    } ]
                }, 'error returned');
            }

            cb();
        });
    }, function () {
        t.done();
    });
};


exports.create_docker_vm = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        cpu_cap: 100,
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER,
        tags: {
           'docker:label:com.docker.blah': 'quux'
        }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');

        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        newUuid = body.vm_uuid;
        vmLocation = '/vms/' + newUuid;

        t.done();
    });
};


exports.wait_provisioned_docker_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', {
        client: client
    }, function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.add_docker_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        'foo': 'bar',
        'docker:label:com.docker.blah': 'baz'
    };

    var opts = createOpts(path, query);

    client.post(opts, query, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(err.restCode, 'ValidationFailed');
        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid tag parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" ' +
                    'not supported'
            } ]
        });

        t.done();
    });
};


exports.set_docker_tag_1 = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        'foo': 'bar',
        'docker:label:com.docker.blah': 'baz'
    };

    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid tag parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" not ' +
                    'supported'
            } ]
        });

        t.done();
    });
};


exports.set_docker_tag_2 = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
       foo: 'bar'
    };
    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        var restCode = (err ? err.restCode : undefined);

        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid tag parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.update_docker_vm = function (t) {
    var params = {
        action: 'update',
        tags: {
            foo: 'bar'
        }
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid VM update parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.delete_docker_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/docker%3Alabel%3Acom.docker.blah' +
        '?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid tag parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.delete_docker_all_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409, '409 Conflict');
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid tag parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.destroy_docker_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.destroy_test_vms_final = function (t) {
    destroyTestVms(function (destroyErr, destroyObj) {
        common.ifError(t, destroyErr);

        if (!destroyErr) {
            assert.object(destroyObj, 'destroyObj');
            assert.number(destroyObj.destroyedVms, 'destroyObj.destroyedVms');
            t.ok(true, util.format('destroyed %d test vms',
                destroyObj.destroyedVms));
        }

        t.done();
    });
};


/**
 * Fabric NAT provision and destroy testing.
 *
 * Start off with no NAT provisioned, create a vm that uses a fabric NAT,
 * test that a NAT zone was provisioned as part of the vm provisioning process.
 * Destroy the vm, then check back to ensure the NAT zone was also destroyed.
 */

exports.find_fabric_network = function (t) {
    assert.arrayOfObject(NETWORKS, 'NETWORKS');

    // Find a fabric network that is owned by CUSTOMER. If none is found, skip
    // the tests that depend on the availability of one.
    fabricNetwork = NETWORKS.find(function _findFabricNetwork(n) {
        return n.fabric === true && Array.isArray(n.owner_uuids) &&
            n.owner_uuids.indexOf(CUSTOMER) >= 0;
    });

    if (fabricNetwork) {
        assert.object(fabricNetwork, 'fabricNetwork');
        assert.string(fabricNetwork.name, 'fabricNetwork.name');
        assert.uuid(fabricNetwork.uuid, 'fabricNetwork.uuid');
        t.ok(true, util.format('using fabric network "%s": %s',
            fabricNetwork.name, fabricNetwork.uuid));
    } else {
        t.ok(true, 'no fabric networks found, skipping fabric tests');
    }

    t.done();
};


exports.ensure_no_fabric_nat_provisioned = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    var opts = createOpts('/vms');
    opts.query = {
        alias: 'nat-' + fabricNetwork.uuid,
        state: 'active'
    };

    client.get(opts, function (err, req, res, vms) {
        /**
         * We exect that vms is an empty array.
         */
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'expected a 200 status');
        t.equal(vms.length, 0, 'should be no NAT vm found');

        t.done();
    });
};


exports.create_vm_on_fabric_network = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: fabricNetwork.uuid } ],
        brand: 'joyent-minimal',
        billing_id: pkgId
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');

        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        newUuid = body.vm_uuid;
        vmLocation = '/vms/' + newUuid;

        t.done();
    });
};


exports.wait_provisioned_fabric_vm_job = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    waitForValue(jobLocation, 'execution', 'succeeded',  {client: client},
            function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.ensure_fabric_nat_provisioned = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    var opts = createOpts('/vms');
    opts.query = {
        alias: 'nat-' + fabricNetwork.uuid,
        state: 'active'
    };

    client.get(opts, function (err, req, res, vms) {
        var vm;

        /**
         * We expect to get back an array containing one running vm.
         */
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'expected a 200 status');

        t.ok(Array.isArray(vms), 'should get vms array object');
        if (!Array.isArray(vms)) {
            t.done();
            return;
        }

        t.equal(vms.length, 1, 'should have found one NAT vm');
        if (vms.length !== 1) {
            t.done();
            return;
        }

        vm = vms[0];
        assert.object(vm, 'vm');
        assert.uuid(vm.uuid, 'vm.uuid');

        t.equal(vm.state, 'running', 'NAT vm should be running');
        natZoneUuid = vm.uuid;

        t.ok(true, 'NAT vm uuid: ' + natZoneUuid);

        t.done();
    });
};


exports.destroy_fabric_vm = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');
        jobLocation = '/jobs/' + body.job_uuid;
        t.ok(true, 'jobLocation: ' + jobLocation);
        t.done();
    });
};


exports.wait_destroyed_fabric_vm_job = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    waitForValue(jobLocation, 'execution', 'succeeded', {client: client},
            function (err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.ensure_fabric_nat_destroyed = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    if (!natZoneUuid) {
        t.fail('NAT zone not created');
        t.done();
        return;
    }

    var opts = createOpts('/vms/' + natZoneUuid);

    client.get(opts, function (err, req, res, vm) {
        /**
         * We expect to get back a destroyed vm.
         */
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'expected a 200 status');
        t.ok(vm, 'expected a vm');
        if (vm) {
            t.equal(vm.state, 'destroyed', 'vm should be in destroyed state');
        }

        t.done();
    });
};


exports.ensure_no_fabric_nat_zone = function (t) {
    if (!fabricNetwork) {
        t.ok(true, 'skipping, as no fabric network available');
        t.done();
        return;
    }

    var opts = createOpts('/vms');
    opts.query = {
        alias: 'nat-' + fabricNetwork.uuid,
        state: 'active'
    };

    client.get(opts, function (err, req, res, vms) {
        /**
         * There should get no vms returned.
         */
        common.ifError(t, err);
        t.equal(res.statusCode, 200, 'expected a 200 status');
        t.equal(vms.length, 0, 'should be no NAT vm found');

        t.done();
    });
};

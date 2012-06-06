/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var ldap = require('ldapjs');
var sprintf = require('sprintf').sprintf;

var common = require('../common');

var uuid = require('node-uuid');

var VALID_VM_ACTIONS = [
    'start',
    'stop',
    'reboot',
    'update'
];


function validAction(action) {
    return VALID_VM_ACTIONS.indexOf(action) != -1;
}



/*
 * GET /vms/:uuid
 *
 * Returns a list of vms according the specified search filter. The valid
 * query options are: owner_uuid, brand, alias, status, and ram.
 */
function listVms(req, res, next) {
    req.log.trace('ListVms start');

    req.ufds.listVms(req.params, function (err, vms) {
        if (err)
            return next(err);

        res.send(200, vms);
        return next();
    });
}



/*
 * GET /vms/:uuid
 */
function getVm(req, res, next) {
    req.log.trace('GetVm start');
    var m = req.vm;

    if (m.server_uuid && req.params.sync && req.params.sync == 'true') {
        req.cnapi.getVm(m.server_uuid, m.uuid, function (err, vm) {
            if (err)
                return next(err);

            if (vm) {
                var newVm = common.translateVm(vm, true);
                req.cache.set(newVm.uuid, newVm);
                res.send(200, newVm);
            } else {
                markAsDestroyed(req);
                res.send(200, req.vm);
            }
            return next();
        });
    } else {
        res.send(200, m);
        return next();
    }
}



/*
 * POST /vms/:uuid
 */
function updateVm(req, res, next) {
    req.log.trace('UpdateVm start');
    var method;
    var action = req.params.action;

    if (!action)
        return next(new restify.MissingParameterError('action is required'));

    if (!validAction(action))
        return next(new restify.InvalidArgumentError('%s is not a valid action',
                                             req.params.action));

    switch (action) {
        case 'start':
            method = startVm;
            break;
        case 'stop':
            method = stopVm;
            break;
        case 'reboot':
            method = rebootVm;
            break;
        case 'update':
            method = changeVm;
            break;
        default:
            next(new restify.InvalidArgumentError('%s is not a valid action',
                     req.params.action));
            break;
    }

    return method.call(this, req, res, next);
}



/*
 * Streams a response or responds immediately with a job_uuid and vm_uuid
 * object. This part of the chain is called by VM actions that create a new
 * job when successful
 */
 function streamResponse(req, res, next) {
    req.log.trace('StreamResponse start');

    if (req.params.sync && req.params.sync == 'true') {
        res.defaultResponseHeaders();
        res.writeHead(200, { 'content-type': 'application/json' });

        req.wfapi.pipeJob(res, req.juuid, function (err) {
            if (err)
                return next(err);

            res.end();
            return next();
        });
    } else {
        res.send(200, { vm_uuid: req.vm.uuid, job_uuid: req.juuid });
        return next();
    }
}



/*
 * Starts a vm with ?action=start
 */
function startVm(req, res, next) {
    req.log.trace('StartVm start');

    req.wfapi.createStartJob(req, function (err, juuid) {
        if (err)
            return next(err);

        req.juuid = juuid;
        return next();
    });
}



/*
 * Stops a vm with ?action=stop
 */
function stopVm(req, res, next) {
    req.log.trace('StopVm start');

    req.wfapi.createStopJob(req, function (err, juuid) {
        if (err)
            return next(err);
        
        req.juuid = juuid;
        return next();
    });
}



/*
 * Reboots a vm with ?action=reboot
 */
function rebootVm(req, res, next) {
    req.log.trace('RebootVm start');

    req.wfapi.createRebootJob(req, function (err, juuid) {
        if (err)
            return next(err);

        req.juuid = juuid;
        return next();
    });
}



/*
 * Changes a vm with ?action=update
 */
function changeVm(req, res, next) {
    req.log.trace('ChangeVm start');

    try {
      var params = common.validateUpdate(req.params);

      return req.wfapi.createUpdateJob(req, params, function (err, juuid) {
            if (err)
                return next(err);
            req.juuid = juuid;
            return next();
      });
    } catch (e) {
        return next(e);
    }
}


/*
 * Helper function for marking a vm as destroyed
 */
function markAsDestroyed(req, res, next) {
    req.ufds.markAsDestroyed(req.cache, req.vm, function (err) {
        if (err) {
            req.log.error('Error marking ' + req.vm.uuid +
                            ' as destroyed on UFDS', err);
        } else {
            req.log.info('VM ' + req.vm.uuid +
                          ' marked as destroyed on UFDS');
        }
    });
}


/*
 * Deletes a vm
 */
function deleteVm(req, res, next) {
    req.log.trace('DeleteVm start');

    req.wfapi.createDestroyJob(req, function (err, juuid) {
        if (err)
            return next(err);

        req.juuid = juuid;
        return next();
    });
}



/*
 * Creates a new vm. This endpoint returns a task id that can be used to
 * keep track of the vm provision
 */
function createVm(req, res, next) {
    req.log.trace('CreateVm start');

    common.validateVm(req.ufds, req.params, function(error) {
        if (error)
            return next(error);

        common.setDefaultValues(req.params);

        return req.wfapi.createProvisionJob(req,
        function (err, vmuuid, juuid) {
            if (err)
                  return next(err);

            req.params.state = 'provisioning';
            req.params.uuid = vmuuid;

            var vm = common.translateVm(req.params, true);
            req.cache.set(vm.uuid, vm);

            res.send(201, { vm_uuid: vm.uuid, job_uuid: juuid });
            return next();
        });
    });
}



/*
 * Mounts vm actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/vms', name: 'ListVms' },
                 before, listVms);

    server.post({ path: '/vms', name: 'CreateVm' },
                  before, createVm);

    server.get({ path: '/vms/:uuid', name: 'GetVm' },
                 before, getVm);

    server.del({ path: '/vms/:uuid', name: 'DeleteVm' },
                 before, deleteVm, streamResponse, markAsDestroyed);

    server.post({ path: '/vms/:uuid', name: 'UpdateVm' },
                  before, updateVm, streamResponse);
}


// --- Exports

module.exports = {
    mount: mount
};
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This job adds a new NIC to a VM. It needs to checks that the nic tags
 * required by the NIC are present on the CN, creates a NIC in NAPI
 * (but only if 'networks' are provided in the job params), then invoke CNAPI
 * to create the NIC on the CN itself and attach it to the VM.
 *
 * Although this job only creates a NIC in NAPI if 'networks' is provided --
 * if 'mac' is provided, the NIC was already pre-created in NAPI -- this job
 * must always delete the NIC from NAPI on job failure.
 */

var async;  // stub to keep jsl happy
var common = require('./job-common');
var fabricCommon = require('./fabric-common');

var VERSION = '7.3.0';


/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.action = 'add_nics';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}



var workflow = module.exports = {
    name: 'add-nics-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }

    /**
     * Fabric NAT provisioning
     */
    ].concat(
        fabricCommon.provisionChain).concat([
    {
        name: 'common.update_network_params',
        timeout: 10,
        retry: 1,
        body: common.updateNetworkParams,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.acquire_vm_ticket',
        timeout: 10,
        retry: 1,
        body: common.acquireVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.wait_on_vm_ticket',
        timeout: 120,
        retry: 1,
        body: common.waitOnVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    },
    /*
     * If we've provisioned fabric NAT zones for this VM, wait until
     * they've finished before updating the VM.
     */
    fabricCommon.provisionWaitTask
    ]).concat([ {
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.wait_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.put_vm',
        timeout: 60,
        retry: 1,
        body: common.putVm,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    },

    // If this was a fabric nat provision, clean up the ticket
    fabricCommon.releaseTicketTask

    ]),
    timeout: 300,
    onerror: [ {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    },
    {
        name: 'on_error.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicket
    },
    fabricCommon.releaseTicketTask,
    {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }],
    oncancel: [
    {
        name: 'on_cancel.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicket
    },
        fabricCommon.releaseTicketTask
    ]
};

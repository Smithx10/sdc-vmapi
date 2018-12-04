/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Used to migrate an instance, run via this workflow job.
 */

var common = require('./job-common');
var migrationCommon = require('./vm-migration/common');
var modSwitch = require('./vm-migration/switch');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-switch-' + VERSION,
    version: VERSION,
    timeout: 1800,

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        /* Stop the vm */
        modSwitch.tasks.stopVm,
        common.tasks.waitForWorkflowJob,

        /* Run the final sync */
        modSwitch.tasks.startFinalSync,
        common.tasks.waitForWorkflowJob,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        modSwitch.tasks.ensureVmStopped,

        /* Switch over instances. */
        modSwitch.tasks.reserveNetworkIps,
        modSwitch.tasks.storeReservedNetworkIps,

        migrationCommon.tasks.storeInitialRecord,

        modSwitch.tasks.getSourceCoreFilesystemSize,
        common.tasks.waitTask,

        modSwitch.tasks.setupTargetFilesystem,
        common.tasks.waitTask,

        modSwitch.tasks.setTargetVmAutoboot,
        common.tasks.waitTask,

        modSwitch.tasks.setSourceDoNotInventory,
        common.tasks.waitTask,

        modSwitch.tasks.updateVmServerUuid,

        modSwitch.tasks.removeTargetDoNotInventory,
        common.tasks.waitTask,

        migrationCommon.tasks.storeSuccess,

        common.tasks.releaseVMTicket,

        /* Restart the vm */
        modSwitch.tasks.startTargetVm,
        common.tasks.waitForWorkflowJob
    ],

    onerror: [
        // TODO: Restore any networks.
        // TOOD: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        modSwitch.tasks.startSourceVm,

        {
            name: 'on_error.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ],

    oncancel: [
        // TODO: Restore any networks.
        // TOOD: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        modSwitch.tasks.startSourceVm,
        {
            name: 'on_cancel.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ]
};
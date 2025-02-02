/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Used to migrate an instance, run via this workflow job.
 */

var common = require('./job-common');
var migrationBegin = require('./vm-migration/begin');
var migrationCommon = require('./vm-migration/common');

var VERSION = '1.0.0';


var workflow = module.exports = {
    name: 'migrate-begin-' + VERSION,
    version: VERSION,
    timeout: 1200,

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.getSourceFilesystemDetails,
        common.tasks.waitTask,
        migrationBegin.tasks.storeSourceFilesystemDetails,

        migrationBegin.tasks.createProvisionPayload,

        common.tasks.acquireAllocationTicket,
        common.tasks.waitOnAllocationTicket,

        migrationBegin.tasks.allocateServer,

        common.tasks.releaseAllocationTicket,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        migrationCommon.tasks.storeInitialRecord,

        migrationCommon.tasks.disallowRetry,

        /* Other vm actions are allowed now. */
        common.tasks.releaseVMTicket,

        migrationBegin.tasks.provisionVm,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.setCreateTimestamp,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.getTargetFilesystemDetails,
        common.tasks.waitTask,
        migrationBegin.tasks.storeTargetFilesystemDetails,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.removeTargetZfsQuota,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.removeSourceZfsQuota,
        common.tasks.waitTask,

        migrationCommon.tasks.storeSuccess,

        migrationBegin.tasks.startSyncWhenAutomatic
    ],

    onerror: [
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};

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
var cleanupSource = require('./vm-migration/cleanup_source');
var cleanupTarget = require('./vm-migration/cleanup_target');
var migrationCommon = require('./vm-migration/common');
var migrationSync = require('./vm-migration/sync');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-sync-' + VERSION,
    version: VERSION,
    timeout: 60 * 60 * 24, // 1 day

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        /* Stop any old migration processes that are still running. */
        cleanupSource,
        cleanupTarget,

        migrationCommon.tasks.storeInitialRecord,

        /* Other vm actions are allowed now. */
        common.tasks.releaseVMTicket,

        /* Start source migration listener process. */
        common.tasks.setupForWaitTask,
        migrationCommon.tasks.setupCnapiSource,
        common.tasks.waitTask,

        /* Start target migration listener process. */
        common.tasks.setupForWaitTask,
        migrationCommon.tasks.setupCnapiTarget,
        common.tasks.waitTask,

        migrationCommon.tasks.storeProcessDetails,

        /* Do the sync */
        migrationSync.tasks.sync,

        migrationCommon.tasks.storeSuccess,

        migrationSync.tasks.startSyncOrSwitchWhenAutomatic
    ],

    onerror: [
        cleanupSource,
        cleanupTarget,
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        cleanupSource,
        cleanupTarget,
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};

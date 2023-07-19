/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { getMutagenDataDir, getMutagenEnv, mutagenCliSpec, parseSyncListResult } from "../../../mutagen"
// import { MUTAGEN_DIR_NAME } from "../../../constants"
// import { join } from "path"
import { pathExists } from "fs-extra"
import { dedent } from "../../../util/string"
import { Log } from "../../../logger/log-entry"
import { PluginTool } from "../../../util/ext-tools"
import { PluginCommand } from "../../../plugin/command"

const logSuccess = (log: Log) => log.info({ msg: chalk.green("\nDone!") })

export const syncStatus: PluginCommand = {
  name: "sync-status",
  description: `Get the sync status for any active Kubernetes/container syncs.`,
  title: "Get the current sync status",

  handler: async ({ ctx, log }) => {
    const dataDir = getMutagenDataDir(ctx.gardenDirPath)
    console.log("yoyo-1", dataDir)
    const mutagen = new PluginTool(mutagenCliSpec)

    if (!(await pathExists(dataDir))) {
      log.info(dedent`
        No active sync session found.
      `)

      logSuccess(log)
      return { result: [] }
    }

    const syncSessions = await getMutagenSyncSessions({ log, dataDir, mutagen })
    const result = { syncSessions }

    if (syncSessions.length === 0) {
      log.info(`Found 0 syncs.`)
    } else {
      log.info(`Found ${syncSessions.length} syncs:`)
      log.info({ data: syncSessions })
    }

    logSuccess(log)

    return { result }
  },
}

export const syncPause: PluginCommand = {
  name: "sync-pause",
  description: `Pause all active Kubernetes/container syncs. Can be resumed with the sync-resume command.`,
  title: "Pause sync",

  handler: async ({ ctx, log }) => {
    const dataDir = getMutagenDataDir(ctx.gardenDirPath)
    const mutagen = new PluginTool(mutagenCliSpec)

    if (!(await pathExists(dataDir))) {
      log.info(dedent`
        No active sync session found.

        Garden needs to be running in dev mode in this project to be able to pause syncs.
      `)

      logSuccess(log)
      return { result: [] }
    }

    const syncSessions = await getMutagenSyncSessions({ log, dataDir, mutagen })
    const activeSyncSessionNames = syncSessions.filter((s) => !s.paused).map((s) => s.name)
    const result = { pausedSessionNames: activeSyncSessionNames }

    if (syncSessions.length === 0) {
      log.info(`No syncs found.`)
    } else if (activeSyncSessionNames.length === 0) {
      log.info(`Sync are already paused.`)
    } else {
      log.info(`Pausing ${activeSyncSessionNames.length} syncs.`)
      for (const sessionName of activeSyncSessionNames) {
        log.debug(`Pausing sync session ${sessionName}`)
        await mutagen.exec({
          cwd: dataDir,
          log,
          env: getMutagenEnv(dataDir),
          args: ["sync", "pause", sessionName],
        })
      }
    }

    logSuccess(log)
    return { result }
  },
}

export const syncResume: PluginCommand = {
  name: "sync-resume",
  description: `Resume all paused syncs.`,
  title: "Resume sync",

  handler: async ({ ctx, log }) => {
    const dataDir = getMutagenDataDir(ctx.gardenDirPath)
    const mutagen = new PluginTool(mutagenCliSpec)

    if (!(await pathExists(dataDir))) {
      log.info(dedent`
        No active sync session found.

        Garden needs to be running in dev mode in this project to be able to resume syncs.
      `)

      logSuccess(log)
      return { result: [] }
    }

    const syncSessions = await getMutagenSyncSessions({ log, dataDir, mutagen })
    const pausedSyncSessionNames = syncSessions.filter((s) => s.paused).map((s) => s.name)
    const result = { resumedSessionNames: pausedSyncSessionNames }

    if (syncSessions.length === 0) {
      log.info(`No syncs found.`)
    } else if (pausedSyncSessionNames.length === 0) {
      log.info(`Syncs are already active.`)
    } else {
      log.info(`Resuming ${pausedSyncSessionNames.length} syncs.`)
      for (const sessionName of pausedSyncSessionNames) {
        log.debug(`Resuming sync session ${sessionName}`)
        await mutagen.exec({
          cwd: dataDir,
          log,
          env: getMutagenEnv(dataDir),
          args: ["sync", "resume", sessionName],
        })
      }
    }

    logSuccess(log)
    return { result }
  },
}

async function getMutagenSyncSessions({ mutagen, dataDir, log }: { mutagen: PluginTool; dataDir: string; log: Log }) {
  console.log("yoyo getMutagenSyncSessions", dataDir)
  const res = await mutagen.exec({
    cwd: dataDir,
    log,
    env: getMutagenEnv(dataDir),
    args: ["sync", "list", "--template={{ json . }}"],
  })
  return parseSyncListResult(res)
}

// function getMutagenDataDir(gardenDirPath: string) {
//   return join(gardenDirPath, MUTAGEN_DIR_NAME)
// }

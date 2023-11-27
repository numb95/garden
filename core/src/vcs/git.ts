/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { performance } from "perf_hooks"
import { isAbsolute, join, posix, relative, resolve } from "path"
import { isString } from "lodash-es"
import fsExtra from "fs-extra"
import { PassThrough } from "stream"
import type {
  BaseIncludeExcludeFiles,
  GetFilesParams,
  IncludeExcludeFilesParser,
  RemoteSourceParams,
  VcsFile,
  VcsHandlerParams,
  VcsInfo,
} from "./vcs.js"
import { VcsHandler } from "./vcs.js"
import type { GardenError } from "../exceptions.js"
import { ChildProcessError, ConfigurationError, isErrnoException, RuntimeError } from "../exceptions.js"
import { getStatsType, joinWithPosix, matchPath } from "../util/fs.js"
import { dedent, deline, splitLast } from "../util/string.js"
import { defer, exec } from "../util/util.js"
import type { Log } from "../logger/log-entry.js"
import parseGitConfig from "parse-git-config"
import type { Profiler } from "../util/profiling.js"
import { getDefaultProfiler, Profile } from "../util/profiling.js"
import isGlob from "is-glob"
import { pMemoizeDecorator } from "../lib/p-memoize.js"
import AsyncLock from "async-lock"
import PQueue from "p-queue"
import { isSha1 } from "../util/hashing.js"
import split2 from "split2"
import type { ExecaError } from "execa"
import { execa } from "execa"
import hasha from "hasha"
import { styles } from "../logger/styles.js"

const { createReadStream, ensureDir, lstat, pathExists, readlink, realpath, stat } = fsExtra

const submoduleErrorSuggestion = `Perhaps you need to run ${styles.underline(`git submodule update --recursive`)}?`

interface GitEntry extends VcsFile {
  mode: string
}

export function getCommitIdFromRefList(refList: string[]): string {
  try {
    return refList[0].split("\t")[0]
  } catch (err) {
    return refList[0]
  }
}

export function parseGitUrl(url: string) {
  const parts = splitLast(url, "#")
  if (!parts[0]) {
    throw new ConfigurationError({
      message: deline`
        Repository URLs must contain a hash part pointing to a specific branch or tag
        (e.g. https://github.com/org/repo.git#main). Actually got: '${url}'`,
    })
  }
  const parsed = { repositoryUrl: parts[0], hash: parts[1] }
  return parsed
}

export interface GitCli {
  (...args: (string | undefined)[]): Promise<string[]>
}

interface GitSubTreeIncludeExcludeFiles extends BaseIncludeExcludeFiles {
  hasIncludes: boolean
  absExcludes: string[]
}

const getIncludeExcludeFiles: IncludeExcludeFilesParser<GetFilesParams, GitSubTreeIncludeExcludeFiles> = async (
  params: GetFilesParams
) => {
  const { path } = params
  let { include, exclude } = params

  if (!exclude) {
    exclude = []
  }
  // Make sure action config is not mutated
  exclude = [...exclude, "**/.garden/**/*"]

  // Apply the include patterns to the ls-files queries. We use the --glob-pathspecs flag
  // to make sure the path handling is consistent with normal POSIX-style globs used generally by Garden.

  // Due to an issue in git, we can unfortunately only use _either_ include or exclude patterns in the
  // ls-files commands, but not both. Trying both just ignores the exclude patterns.

  if (include?.includes("**/*")) {
    // This is redundant
    include = undefined
  }

  const absExcludes = exclude.map((p) => resolve(path, p))
  const hasIncludes = !!include?.length

  // Need to automatically add `**/*` to directory paths, to match git behavior when filtering.
  const augmentedIncludes = await augmentGlobs(path, include)
  const augmentedExcludes = await augmentGlobs(path, exclude)

  return { include, exclude, augmentedIncludes, augmentedExcludes, hasIncludes, absExcludes }
}

interface Submodule {
  path: string
  url: string
}

// TODO Consider moving git commands to separate (and testable) functions
@Profile()
export class GitHandler extends VcsHandler {
  name = "git"
  repoRoots = new Map()
  profiler: Profiler
  protected lock: AsyncLock

  constructor(params: VcsHandlerParams) {
    super(params)
    this.profiler = getDefaultProfiler()
    this.lock = new AsyncLock()
  }

  gitCli(log: Log, cwd: string, failOnPrompt = false): GitCli {
    /**
     * @throws ChildProcessError
     */
    return async (...args: (string | undefined)[]) => {
      log.silly(`Calling git with args '${args.join(" ")}' in ${cwd}`)
      const { stdout } = await exec("git", args.filter(isString), {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: failOnPrompt ? { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" } : undefined,
      })
      return stdout.split("\n").filter((line) => line.length > 0)
    }
  }

  private async getModifiedFiles(git: GitCli, path: string) {
    try {
      return await git("diff-index", "--name-only", "HEAD", path)
    } catch (err) {
      if (err instanceof ChildProcessError && err.details.code === 128) {
        // no commit in repo
        return []
      } else {
        throw err
      }
    }
  }

  async getRepoRoot(log: Log, path: string, failOnPrompt = false) {
    if (this.repoRoots.has(path)) {
      return this.repoRoots.get(path)
    }

    // Make sure we're not asking concurrently for the same root
    return this.lock.acquire(`repo-root:${path}`, async () => {
      if (this.repoRoots.has(path)) {
        return this.repoRoots.get(path)
      }

      const git = this.gitCli(log, path, failOnPrompt)

      try {
        const repoRoot = (await git("rev-parse", "--show-toplevel"))[0]
        this.repoRoots.set(path, repoRoot)
        return repoRoot
      } catch (err) {
        if (!(err instanceof ChildProcessError)) {
          throw err
        }
        throw explainGitError(err, path)
      }
    })
  }

  /**
   * Returns a list of files, along with file hashes, under the given path, taking into account the configured
   * .ignore files, and the specified include/exclude filters.
   */
  override async getFiles(params: GetFilesParams): Promise<VcsFile[]> {
    return this._getFiles(params)
  }

  /**
   * In order for {@link GitRepoHandler} not to enter infinite recursion when scanning submodules,
   * we need to name the function that recurses in here differently from {@link getFiles}
   * so that {@link getFiles} won't refer to the method in the subclass.
   */
  async _getFiles(params: GetFilesParams): Promise<VcsFile[]> {
    if (params.include && params.include.length === 0) {
      // No need to proceed, nothing should be included
      return []
    }

    const { log, path, pathDescription = "directory", filter, failOnPrompt = false } = params
    const { absExcludes, augmentedExcludes, augmentedIncludes, exclude, hasIncludes, include } =
      await getIncludeExcludeFiles(params)

    const gitLog = log
      .createLog({ name: "git" })
      .debug(
        `Scanning ${pathDescription} at ${path}\n  → Includes: ${include || "(none)"}\n  → Excludes: ${
          exclude || "(none)"
        }`
      )

    try {
      const pathStats = await stat(path)

      if (!pathStats.isDirectory()) {
        gitLog.warn(`Expected directory at ${path}, but found ${getStatsType(pathStats)}.`)
        return []
      }
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        gitLog.warn(`Attempted to scan directory at ${path}, but it does not exist.`)
        return []
      } else {
        throw err
      }
    }

    let files: VcsFile[] = []

    const git = this.gitCli(gitLog, path, failOnPrompt)
    const gitRoot = await this.getRepoRoot(gitLog, path, failOnPrompt)

    // List modified files, so that we can ensure we have the right hash for them later
    const modified = new Set(
      (await this.getModifiedFiles(git, path))
        // The output here is relative to the git root, and not the directory `path`
        .map((modifiedRelPath) => resolve(gitRoot, modifiedRelPath))
    )

    const globalArgs = ["--glob-pathspecs"]
    const lsFilesCommonArgs = ["--cached", "--exclude", this.gardenDirPath]

    if (!hasIncludes) {
      for (const p of exclude) {
        lsFilesCommonArgs.push("--exclude", p)
      }
    }

    // List tracked but ignored files (we currently exclude those as well, so we need to query that specially)
    const trackedButIgnored = new Set(
      !this.ignoreFile
        ? []
        : await git(
            ...globalArgs,
            "ls-files",
            "--ignored",
            ...lsFilesCommonArgs,
            "--exclude-per-directory",
            this.ignoreFile
          )
    )

    // List all submodule paths in the current path
    const submodules = await this.getSubmodules(path)
    const submodulePaths = submodules.map((s) => join(gitRoot, s.path))
    if (submodules.length > 0) {
      gitLog.silly(`Submodules listed at ${submodules.map((s) => `${s.path} (${s.url})`).join(", ")}`)
    }

    let submoduleFiles: Promise<VcsFile[]>[] = []

    // We start processing submodule paths in parallel
    // and don't await the results until this level of processing is completed
    if (submodulePaths.length > 0) {
      // Resolve submodules
      // TODO: see about optimizing this, avoiding scans when we're sure they'll not match includes/excludes etc.
      submoduleFiles = submodulePaths.map(async (submodulePath) => {
        if (!submodulePath.startsWith(path) || absExcludes?.includes(submodulePath)) {
          return []
        }

        // Note: We apply include/exclude filters after listing files from submodule
        const submoduleRelPath = relative(path, submodulePath)

        // Catch and show helpful message in case the submodule path isn't a valid directory
        try {
          const pathStats = await stat(path)

          if (!pathStats.isDirectory()) {
            const pathType = getStatsType(pathStats)
            gitLog.warn(`Expected submodule directory at ${path}, but found ${pathType}. ${submoduleErrorSuggestion}`)
            return []
          }
        } catch (err) {
          if (isErrnoException(err) && err.code === "ENOENT") {
            gitLog.warn(
              `Found reference to submodule at ${submoduleRelPath}, but the path could not be found. ${submoduleErrorSuggestion}`
            )
            return []
          } else {
            throw err
          }
        }

        return this._getFiles({
          log: gitLog,
          path: submodulePath,
          pathDescription: "submodule",
          exclude: [],
          filter: (p) =>
            matchPath(join(submoduleRelPath, p), augmentedIncludes, augmentedExcludes) && (!filter || filter(p)),
          scanRoot: submodulePath,
          failOnPrompt,
        })
      })
    }

    // Make sure we have a fresh hash for each file
    let count = 0

    const ensureHash = async (file: VcsFile, stats: fsExtra.Stats | undefined): Promise<void> => {
      if (file.hash === "" || modified.has(file.path)) {
        // Don't attempt to hash directories. Directories (which will only come up via symlinks btw)
        // will by extension be filtered out of the list.
        if (stats && !stats.isDirectory()) {
          const hash = await this.hashObject(stats, file.path)
          if (hash !== "") {
            file.hash = hash
            count++
            files.push(file)
            return
          }
        }
      }
      count++
      files.push(file)
    }

    // This function is called for each line output from the ls-files commands that we run, and populates the
    // `files` array.
    const handleEntry = async (entry: GitEntry | undefined): Promise<void> => {
      if (!entry) {
        return
      }

      const { path: filePath, hash } = entry

      // Check filter function, if provided
      if (filter && !filter(filePath)) {
        return
      }
      // Ignore files that are tracked but still specified in ignore files
      if (trackedButIgnored.has(filePath)) {
        return
      }

      const resolvedPath = resolve(path, filePath)

      // Filter on excludes and submodules
      if (submodulePaths.includes(resolvedPath)) {
        return
      }

      if (hasIncludes && !matchPath(filePath, undefined, exclude)) {
        return
      }

      // We push to the output array if it passes through the exclude filters.
      const output = { path: resolvedPath, hash: hash || "" }

      // No need to stat unless it has no hash, is a symlink, or is modified
      // Note: git ls-files always returns mode 120000 for symlinks
      if (hash && entry.mode !== "120000" && !modified.has(resolvedPath)) {
        return ensureHash(output, undefined)
      }

      try {
        const stats = await lstat(resolvedPath)
        // We need to special-case handling of symlinks. We disallow any "unsafe" symlinks, i.e. any ones that may
        // link outside of `gitRoot`.
        if (stats.isSymbolicLink()) {
          const target = await readlink(resolvedPath)

          // Make sure symlink is relative and points within `path`
          if (isAbsolute(target)) {
            gitLog.verbose(`Ignoring symlink with absolute target at ${resolvedPath}`)
            return
          } else if (target.startsWith("..")) {
            try {
              const realTarget = await realpath(resolvedPath)
              const relPath = relative(path, realTarget)

              if (relPath.startsWith("..")) {
                gitLog.verbose(`Ignoring symlink pointing outside of ${pathDescription} at ${resolvedPath}`)
                return
              }
              return ensureHash(output, stats)
            } catch (err) {
              if (isErrnoException(err) && err.code === "ENOENT") {
                gitLog.verbose(`Ignoring dead symlink at ${resolvedPath}`)
                return
              }
              throw err
            }
          } else {
            return ensureHash(output, stats)
          }
        } else {
          return ensureHash(output, stats)
        }
      } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
          return
        }
        throw err
      }
    }

    const queue = new PQueue()
    // Prepare args
    const args = [...globalArgs, "ls-files", "-s", "--others", ...lsFilesCommonArgs]
    if (this.ignoreFile) {
      args.push("--exclude-per-directory", this.ignoreFile)
    }
    args.push(...(include || []))

    // Start git process
    gitLog.silly(() => `Calling git with args '${args.join(" ")}' in ${path}`)
    const processEnded = defer<void>()

    const proc = execa("git", args, { cwd: path, buffer: false })
    const splitStream = split2()

    // Stream
    const fail = (err: unknown) => {
      proc.kill()
      splitStream.end()
      processEnded.reject(err)
    }

    splitStream.on("data", async (line) => {
      try {
        await queue.add(() => {
          return handleEntry(parseLine(line))
        })
      } catch (err) {
        fail(err)
      }
    })

    proc.stdout?.pipe(splitStream)

    void proc.on("error", (err: ExecaError) => {
      if (err.exitCode !== 128) {
        fail(err)
      }
    })

    void splitStream.on("end", () => {
      processEnded.resolve()
    })

    // The stream that adds files to be processed has started
    // We wait until the process is completed and then
    // we wait until the queue is empty
    // After that we're done with all possible files to be processed
    await processEnded.promise
    await queue.onIdle()

    gitLog.debug(`Found ${count} files in ${pathDescription} ${path}`)

    // We have done the processing of this level of files
    // So now we just have to wait for all the recursive submodules to resolve as well
    // before we can return
    const resolvedSubmoduleFiles = await Promise.all(submoduleFiles)

    files = [...files, ...resolvedSubmoduleFiles.flat()]

    return files
  }

  private async cloneRemoteSource(
    log: Log,
    repositoryUrl: string,
    hash: string,
    absPath: string,
    failOnPrompt = false
  ) {
    await ensureDir(absPath)
    const git = this.gitCli(log, absPath, failOnPrompt)
    // Use `--recursive` to include submodules
    if (!isSha1(hash)) {
      return git(
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--recursive",
        "--depth=1",
        "--shallow-submodules",
        `--branch=${hash}`,
        repositoryUrl,
        "."
      )
    }

    // If SHA1 is used we need to fetch the changes as git clone doesn't allow to shallow clone
    // a specific hash
    try {
      await git("init")
      await git("remote", "add", "origin", repositoryUrl)
      await git("-c", "protocol.file.allow=always", "fetch", "--depth=1", "--recurse-submodules=yes", "origin", hash)
      await git("checkout", "FETCH_HEAD")
      return git("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    } catch (err) {
      throw new RuntimeError({
        message: dedent`
          Failed to shallow clone with error: ${err}

          Make sure both git client and server are newer than 2.5.0 and that \`uploadpack.allowReachableSHA1InWant=true\` is set on the server`,
      })
    }
  }

  // TODO Better auth handling
  async ensureRemoteSource({ url, name, log, sourceType, failOnPrompt = false }: RemoteSourceParams): Promise<string> {
    return this.getRemoteSourceLock(sourceType, name, async () => {
      const remoteSourcesPath = this.getRemoteSourcesLocalPath(sourceType)
      await ensureDir(remoteSourcesPath)

      const absPath = this.getRemoteSourceLocalPath(name, url, sourceType)
      const isCloned = await pathExists(absPath)

      if (!isCloned) {
        const gitLog = log.createLog({ name, showDuration: true }).info(`Fetching from ${url}`)
        const { repositoryUrl, hash } = parseGitUrl(url)

        try {
          await this.cloneRemoteSource(log, repositoryUrl, hash, absPath, failOnPrompt)
        } catch (err) {
          gitLog.error(`Failed fetching from ${url}`)
          throw new RuntimeError({
            message: `Downloading remote ${sourceType} (from ${url}) failed with error: \n\n${err}`,
          })
        }

        gitLog.success("Done")
      }

      return absPath
    })
  }

  async updateRemoteSource({ url, name, sourceType, log, failOnPrompt = false }: RemoteSourceParams) {
    const absPath = this.getRemoteSourceLocalPath(name, url, sourceType)
    const git = this.gitCli(log, absPath, failOnPrompt)
    const { repositoryUrl, hash } = parseGitUrl(url)

    await this.ensureRemoteSource({ url, name, sourceType, log, failOnPrompt })

    await this.getRemoteSourceLock(sourceType, name, async () => {
      const gitLog = log.createLog({ name, showDuration: true }).info("Getting remote state")
      await git("remote", "update")

      const localCommitId = (await git("rev-parse", "HEAD"))[0]
      const remoteCommitId = isSha1(hash) ? hash : getCommitIdFromRefList(await git("ls-remote", repositoryUrl, hash))

      if (localCommitId !== remoteCommitId) {
        gitLog.info(`Fetching from ${url}`)

        try {
          await git("fetch", "--depth=1", "origin", hash)
          await git("reset", "--hard", `origin/${hash}`)
          // Update submodules if applicable (no-op if no submodules in repo)
          await git("-c", "protocol.file.allow=always", "submodule", "update", "--recursive")
        } catch (err) {
          gitLog.error(`Failed fetching from ${url}`)
          throw new RuntimeError({
            message: `Updating remote ${sourceType} (at url: ${url}) failed with error: \n\n${err}`,
          })
        }

        gitLog.success("Source updated")
      } else {
        gitLog.success("Source already up to date")
      }
    })
  }

  private getRemoteSourceLock(sourceType: string, name: string, func: () => Promise<any>) {
    return this.lock.acquire(`remote-source-${sourceType}-${name}`, func)
  }

  /**
   * Replicates the `git hash-object` behavior. See https://stackoverflow.com/a/5290484/3290965
   * We deviate from git's behavior when dealing with symlinks, by hashing the target of the symlink and not the
   * symlink itself. If the symlink cannot be read, we hash the link contents like git normally does.
   */
  async hashObject(stats: fsExtra.Stats, path: string): Promise<string> {
    const start = performance.now()
    const hash = hasha.stream({ algorithm: "sha1" })

    if (stats.isSymbolicLink()) {
      // For symlinks, we follow git's behavior, which is to hash the link itself (i.e. the path it contains) as
      // opposed to the file/directory that it points to.
      try {
        const linkPath = await readlink(path)
        hash.update(`blob ${stats.size}\0${linkPath}`)
        hash.end()
        const output = hash.read()
        this.profiler.log("GitHandler#hashObject", start)
        return output
      } catch (err) {
        // Ignore errors here, just output empty hash
        this.profiler.log("GitHandler#hashObject", start)
        return ""
      }
    } else {
      const stream = new PassThrough()
      stream.push(`blob ${stats.size}\0`)

      const result = defer<string>()
      stream
        .on("error", () => {
          // Ignore file read error
          this.profiler.log("GitHandler#hashObject", start)
          result.resolve("")
        })
        .pipe(hash)
        .on("error", (err) => result.reject(err))
        .on("finish", () => {
          const output = hash.read()
          this.profiler.log("GitHandler#hashObject", start)
          result.resolve(output)
        })

      createReadStream(path).pipe(stream)

      return result.promise
    }
  }

  @pMemoizeDecorator()
  private async getSubmodules(gitModulesConfigPath: string) {
    const submodules: Submodule[] = []
    const gitmodulesPath = join(gitModulesConfigPath, ".gitmodules")

    if (await pathExists(gitmodulesPath)) {
      const parsed = await parseGitConfig({ cwd: gitModulesConfigPath, path: ".gitmodules" })

      for (const [key, spec] of Object.entries(parsed || {}) as any) {
        if (!key.startsWith("submodule")) {
          continue
        }
        spec.path && submodules.push(spec)
      }
    }

    return submodules
  }

  async getPathInfo(log: Log, path: string, failOnPrompt = false): Promise<VcsInfo> {
    const git = this.gitCli(log, path, failOnPrompt)

    const output: VcsInfo = {
      branch: "",
      commitHash: "",
      originUrl: "",
    }

    try {
      output.branch = (await git("rev-parse", "--abbrev-ref", "HEAD"))[0]
      output.commitHash = (await git("rev-parse", "HEAD"))[0]
    } catch (err) {
      if (err instanceof ChildProcessError && err.details.code !== 128) {
        throw err
      }
    }

    try {
      output.originUrl = (await git("config", "--get", "remote.origin.url"))[0]
    } catch (err) {
      // Just ignore if not available
      log.silly(`Tried to retrieve git remote.origin.url but encountered an error: ${err}`)
    }

    return output
  }
}

function gitErrorContains(err: ChildProcessError, substring: string): boolean {
  return err.details.stderr.toLowerCase().includes(substring.toLowerCase())
}

export function explainGitError(err: ChildProcessError, path: string): GardenError {
  // handle some errors with exit codes 128 in a specific manner
  if (err.details.code === 128) {
    if (gitErrorContains(err, "fatal: not a git repository")) {
      // Throw nice error when we detect that we're not in a repo root
      return new RuntimeError({
        message: deline`
    Path ${path} is not in a git repository root. Garden must be run from within a git repo.
    Please run \`git init\` if you're starting a new project and repository, or move the project to an
    existing repository, and try again.
  `,
      })
    }
  }

  // otherwise just re-throw the original error
  return err
}

/**
 * Given a list of POSIX-style globs/paths and a `basePath`, find paths that point to a directory and append `**\/*`
 * to them, such that they'll be matched consistently between git and our internal pattern matching.
 */
export async function augmentGlobs(basePath: string, globs: string[]): Promise<string[]>
export async function augmentGlobs(basePath: string, globs?: string[]): Promise<string[] | undefined>
export async function augmentGlobs(basePath: string, globs?: string[]): Promise<string[] | undefined> {
  if (!globs || globs.length === 0) {
    return globs
  }

  return Promise.all(
    globs.map(async (pattern) => {
      if (isGlob(pattern, { strict: false })) {
        // Pass globs through directly (they won't match a specific directory)
        return pattern
      }

      try {
        const isDir = (await stat(joinWithPosix(basePath, pattern))).isDirectory()
        return isDir ? posix.join(pattern, "**", "*") : pattern
      } catch {
        return pattern
      }
    })
  )
}

const parseLine = (data: Buffer): GitEntry | undefined => {
  const line = data.toString().trim()
  if (!line) {
    return undefined
  }

  let filePath: string
  let mode = ""
  let hash = ""

  const split = line.trim().split("\t")

  if (split.length === 1) {
    // File is untracked
    filePath = split[0]
  } else {
    filePath = split[1]
    const info = split[0].split(" ")
    mode = info[0]
    hash = info[1]
  }

  return { path: filePath, hash, mode }
}

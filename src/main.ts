import * as path from 'path'
import { OutgoingHttpHeaders } from 'http'
import * as core from '@actions/core'
import * as toolcache from '@actions/tool-cache'
import * as semver from 'semver'
import { v4 as uuidV4 } from 'uuid'
import { deleteSync } from 'del'

import { getRequiredInput, getTemporaryDirectory, wrapError } from './util'

import * as api from './api-client'

export function convertToSemVer(version: string): string {
  if (!semver.valid(version)) {
    core.debug(
      `Bundle version ${version} is not in SemVer format. Will treat it as pre-release 0.0.0-${version}.`
    )
    version = `0.0.0-${version}`
  }

  const s = semver.clean(version)
  if (!s) {
    throw new Error(`Bundle version ${version} is not in SemVer format.`)
  }

  return s
}

// eslint-disable-next-line no-shadow
enum ToolsSource {
  Unknown = 'UNKNOWN',
  Local = 'LOCAL',
  Toolcache = 'TOOLCACHE',
  Download = 'DOWNLOAD'
}

function getCodeQLBundleName(): string {
  let platform: string
  if (process.platform === 'win32') {
    platform = 'win64'
  } else if (process.platform === 'linux') {
    platform = 'linux64'
  } else if (process.platform === 'darwin') {
    platform = 'osx64'
  } else {
    return 'codeql-bundle.tar.gz'
  }
  return `codeql-bundle-${platform}.tar.gz`
}

async function getCodeQLBundleDownloadURL(
  tagName: string,
  apiDetails: api.GitHubApiDetails,
  codeqlActionRepo: string
): Promise<string> {
  const codeQLActionRepository: string = codeqlActionRepo
  const [repositoryOwner, repositoryName] = codeQLActionRepository.split('/')
  const codeQLBundleName = getCodeQLBundleName()

  try {
    const release = await api.getApiClient().rest.repos.getReleaseByTag({
      owner: repositoryOwner,
      repo: repositoryName,
      tag: tagName
    })

    for (const asset of release.data.assets) {
      if (asset.name === codeQLBundleName) {
        core.info(
          `Found CodeQL bundle in ${codeQLActionRepository} on ${apiDetails.url} with URL ${asset.url}.`
        )
        return asset.url
      }
    }
  } catch (e) {
    core.info(
      `Looked for CodeQL bundle in ${codeQLActionRepository} on ${apiDetails.url} but got error ${e}.`
    )
  }

  throw new Error('Could not download CodeQL bundle.')
}

function tryGetBundleVersionFromTagName(tagName: string): string | undefined {
  const match = tagName.match(/^codeql-bundle-(.*)$/)
  if (match === null || match.length < 2) {
    core.debug(`Could not determine bundle version from tag ${tagName}.`)
    return undefined
  }
  return match[1]
}

function tryGetTagNameFromUrl(url: string): string | undefined {
  const match = url.match(/\/(codeql-bundle-.*)\//)
  if (match === null || match.length < 2) {
    core.debug(`Could not determine tag name for URL ${url}.`)
    return undefined
  }
  return match[1]
}

function tryGetBundleVersionFromUrl(url: string): string | undefined {
  const tagName = tryGetTagNameFromUrl(url)
  if (tagName === undefined) {
    return undefined
  }
  return tryGetBundleVersionFromTagName(tagName)
}

type CodeQLToolsSource =
  | {
      codeqlTarPath: string
      sourceType: 'local'
      /** Human-readable description of the source of the tools for telemetry purposes. */
      toolsVersion: 'local'
    }
  | {
      codeqlFolder: string
      sourceType: 'toolcache'
      /** Human-readable description of the source of the tools for telemetry purposes. */
      toolsVersion: string
    }
  | {
      /** Bundle version of the tools, if known. */
      bundleVersion?: string
      /** CLI version of the tools, if known. */
      cliVersion?: string
      codeqlURL: string
      sourceType: 'download'
      /** Human-readable description of the source of the tools for telemetry purposes. */
      toolsVersion: string
    }

async function getCodeQLSource(
  toolsInput: string | undefined,
  apiDetails: api.GitHubApiDetails,
  codeqlActionRepo: string
): Promise<CodeQLToolsSource> {
  if (toolsInput && toolsInput !== 'latest' && !toolsInput.startsWith('http')) {
    return {
      codeqlTarPath: toolsInput,
      sourceType: 'local',
      toolsVersion: 'local'
    }
  }

  /** CLI version number, for example 2.12.1. */
  let cliVersion: string | undefined
  /** Tag name of the CodeQL bundle, for example `codeql-bundle-20230120`. */
  let tagName: string | undefined
  /** URL of the CodeQL bundle (may not always include a tag name). */
  let url: string | undefined

  if (!toolsInput || toolsInput === 'latest') {
    const codeQLActionRepository: string = codeqlActionRepo
    const [repositoryOwner, repositoryName] = codeQLActionRepository.split('/')

    const release = await api.getApiClient().rest.repos.getLatestRelease({
      owner: repositoryOwner,
      repo: repositoryName
    })
    tagName = release.data.tag_name
    if (!tagName) {
      throw new Error('Could not get latest release tag.')
    }

    url = await getCodeQLBundleDownloadURL(
      tagName,
      apiDetails,
      codeqlActionRepo
    )
  } else if (toolsInput.startsWith('http')) {
    // If a tools URL was provided, then use that.
    tagName = tryGetTagNameFromUrl(toolsInput)
    url = toolsInput
  }

  if (tagName) {
    const bundleVersion = tryGetBundleVersionFromTagName(tagName)
    // If the bundle version is a semantic version, it is a CLI version number.
    if (bundleVersion && semver.valid(bundleVersion)) {
      cliVersion = convertToSemVer(bundleVersion)
    }
  }

  const bundleVersion = tagName && tryGetBundleVersionFromTagName(tagName)
  const humanReadableVersion =
    cliVersion ??
    (bundleVersion && convertToSemVer(bundleVersion)) ??
    tagName ??
    url ??
    'unknown'

  core.debug(
    'Attempting to obtain CodeQL tools. ' +
      `CLI version: ${cliVersion ?? 'unknown'}, ` +
      `bundle tag name: ${tagName ?? 'unknown'}, ` +
      `URL: ${url ?? 'unspecified'}.`
  )

  let codeqlFolder: string | undefined

  if (cliVersion) {
    // If we find the specified CLI version, we always use that.
    codeqlFolder = toolcache.find('CodeQL', cliVersion)

    // Fall back to matching `x.y.z-<tagName>`.
    if (!codeqlFolder) {
      core.debug(
        "Didn't find a version of the CodeQL tools in the toolcache with a version number " +
          `exactly matching ${cliVersion}.`
      )
      const allVersions = toolcache.findAllVersions('CodeQL')
      core.debug(
        `Found the following versions of the CodeQL tools in the toolcache: ${JSON.stringify(
          allVersions
        )}.`
      )
      // If there is exactly one version of the CodeQL tools in the toolcache, and that version is
      // the form `x.y.z-<tagName>`, then use it.
      const candidateVersions = allVersions.filter(version =>
        version.startsWith(`${cliVersion}-`)
      )
      if (candidateVersions.length === 1) {
        core.debug(
          `Exactly one version of the CodeQL tools starting with ${cliVersion} found in the ` +
            'toolcache, using that.'
        )
        codeqlFolder = toolcache.find('CodeQL', candidateVersions[0])
      } else if (candidateVersions.length === 0) {
        core.debug(
          `Didn't find any versions of the CodeQL tools starting with ${cliVersion} ` +
            `in the toolcache. Trying next fallback method.`
        )
      } else {
        core.warning(
          `Found ${candidateVersions.length} versions of the CodeQL tools starting with ` +
            `${cliVersion} in the toolcache, but at most one was expected.`
        )
        core.debug('Trying next fallback method.')
      }
    }
  }

  // Fall back to matching `0.0.0-<bundleVersion>`.
  if (!codeqlFolder && tagName) {
    const fallbackVersion = await tryGetFallbackToolcacheVersion(
      cliVersion,
      tagName
    )
    if (fallbackVersion) {
      codeqlFolder = toolcache.find('CodeQL', fallbackVersion)
    } else {
      core.debug(
        'Could not determine a fallback toolcache version number for CodeQL tools version ' +
          `${humanReadableVersion}.`
      )
    }
  }

  if (codeqlFolder) {
    core.info(
      `Found CodeQL tools version ${humanReadableVersion} in the toolcache.`
    )
  } else {
    core.info(
      `Did not find CodeQL tools version ${humanReadableVersion} in the toolcache.`
    )
  }

  if (codeqlFolder) {
    return {
      codeqlFolder,
      sourceType: 'toolcache',
      toolsVersion: cliVersion ?? humanReadableVersion
    }
  }

  if (!tagName) {
    throw new Error('Could not determine CodeQL bundle tag name.')
  }

  if (!url) {
    url = await getCodeQLBundleDownloadURL(
      tagName,
      apiDetails,
      codeqlActionRepo
    )
  }

  return {
    bundleVersion: tagName && tryGetBundleVersionFromTagName(tagName),
    cliVersion,
    codeqlURL: url,
    sourceType: 'download',
    toolsVersion: cliVersion ?? humanReadableVersion
  }
}

/**
 * Gets a fallback version number to use when looking for CodeQL in the toolcache if we didn't find
 * the `x.y.z` version. This is to support old versions of the toolcache.
 */
async function tryGetFallbackToolcacheVersion(
  cliVersion: string | undefined,
  tagName: string
): Promise<string | undefined> {
  const bundleVersion = tryGetBundleVersionFromTagName(tagName)
  if (!bundleVersion) {
    return undefined
  }
  const fallbackVersion = convertToSemVer(bundleVersion)
  core.debug(
    `Computed a fallback toolcache version number of ${fallbackVersion} for CodeQL version ` +
      `${cliVersion ?? tagName}.`
  )
  return fallbackVersion
}

function cleanUpGlob(glob: string, name: string): void {
  core.debug(`Cleaning up ${name}.`)
  try {
    const deletedPaths = deleteSync(glob, { force: true })
    if (deletedPaths.length === 0) {
      core.warning(
        `Failed to clean up ${name}: no files found matching ${glob}.`
      )
    } else if (deletedPaths.length === 1) {
      core.debug(`Cleaned up ${name}.`)
    } else {
      core.debug(`Cleaned up ${name} (${deletedPaths.length} files).`)
    }
  } catch (e) {
    core.warning(`Failed to clean up ${name}: ${e}.`)
  }
}

/**
 * Returns the toolcache version number to use to store the bundle with the associated CLI version
 * and bundle version.
 *
 * This is the canonical version number, since toolcaches populated by different versions of the
 * CodeQL Action or different runner image creation scripts may store the bundle using a different
 * version number. Functions like `getCodeQLSource` that fetch the bundle from rather than save the
 * bundle to the toolcache should handle these different version numbers.
 */
function getCanonicalToolcacheVersion(
  cliVersion: string | undefined,
  bundleVersion: string
): string {
  // If the CLI version is a pre-release or contains build metadata, then cache the
  // bundle as `0.0.0-<bundleVersion>` to avoid the bundle being interpreted as containing a stable
  // CLI release. In principle, it should be enough to just check that the CLI version isn't a
  // pre-release, but the version numbers of CodeQL nightlies have the format `x.y.z+<timestamp>`,
  // and we don't want these nightlies to override stable CLI versions in the toolcache.
  if (!cliVersion?.match(/^[0-9]+\.[0-9]+\.[0-9]+$/)) {
    return convertToSemVer(bundleVersion)
  }

  // Include both the CLI version and the bundle version in the toolcache version number. That way
  // we can find the bundle in the toolcache based on either the CLI version or the bundle version.
  return `${cliVersion}-${bundleVersion}`
}

async function downloadCodeQL(
  codeqlURL: string,
  maybeBundleVersion: string | undefined,
  maybeCliVersion: string | undefined,
  apiDetails: api.GitHubApiDetails,
  tempDir: string
): Promise<{
  toolsVersion: string
  codeqlFolder: string
  toolsDownloadDurationMs: number
}> {
  const parsedCodeQLURL = new URL(codeqlURL)
  const searchParams = new URLSearchParams(parsedCodeQLURL.search)
  const headers: OutgoingHttpHeaders = {
    accept: 'application/octet-stream'
  }
  // We only want to provide an authorization header if we are downloading
  // from the same GitHub instance the Action is running on.
  // This avoids leaking Enterprise tokens to dotcom.
  // We also don't want to send an authorization header if there's already a token provided in the URL.
  let authorization: string | undefined = undefined
  if (searchParams.has('token')) {
    core.debug('CodeQL tools URL contains an authorization token.')
  } else if (codeqlURL.startsWith(`${apiDetails.url}/`)) {
    core.debug('Providing an authorization token to download CodeQL tools.')
    authorization = `token ${apiDetails.auth}`
  } else {
    core.debug('Downloading CodeQL tools without an authorization token.')
  }
  core.info(
    `Downloading CodeQL tools from ${codeqlURL}. This may take a while.`
  )

  const dest = path.join(tempDir, uuidV4())
  const finalHeaders = Object.assign(
    { 'User-Agent': 'CodeQL Wrapper Action' },
    headers
  )

  const toolsDownloadStart = performance.now()
  const archivedBundlePath = await toolcache.downloadTool(
    codeqlURL,
    dest,
    authorization,
    finalHeaders
  )
  const toolsDownloadDurationMs = Math.round(
    performance.now() - toolsDownloadStart
  )

  core.debug(
    `Finished downloading CodeQL bundle to ${archivedBundlePath} (${toolsDownloadDurationMs} ms).`
  )

  core.debug('Extracting CodeQL bundle.')
  const extractionStart = performance.now()
  const extractedBundlePath = await toolcache.extractTar(archivedBundlePath)
  const extractionMs = Math.round(performance.now() - extractionStart)
  core.debug(
    `Finished extracting CodeQL bundle to ${extractedBundlePath} (${extractionMs} ms).`
  )
  cleanUpGlob(archivedBundlePath, 'CodeQL bundle archive')

  const bundleVersion =
    maybeBundleVersion ?? tryGetBundleVersionFromUrl(codeqlURL)

  if (bundleVersion === undefined) {
    core.debug(
      'Could not cache CodeQL tools because we could not determine the bundle version from the ' +
        `URL ${codeqlURL}.`
    )
    return {
      toolsVersion: maybeCliVersion ?? 'unknown',
      codeqlFolder: extractedBundlePath,
      toolsDownloadDurationMs
    }
  }

  core.debug('Caching CodeQL bundle.')
  const toolcacheVersion = getCanonicalToolcacheVersion(
    maybeCliVersion,
    bundleVersion
  )
  const toolcachedBundlePath = await toolcache.cacheDir(
    extractedBundlePath,
    'CodeQL',
    toolcacheVersion
  )

  // Defensive check: we expect `cacheDir` to copy the bundle to a new location.
  if (toolcachedBundlePath !== extractedBundlePath) {
    cleanUpGlob(extractedBundlePath, 'CodeQL bundle from temporary directory')
  }

  return {
    toolsVersion: maybeCliVersion ?? toolcacheVersion,
    codeqlFolder: toolcachedBundlePath,
    toolsDownloadDurationMs
  }
}

/**
 * Gets the CodeQL bundle, downloads and installs it in the toolcache if appropriate, and extracts it.
 *
 * This function's implementation for finding a CodeQL source differs from github/codeql-action in the following ways:
 * 1) On GHES, does not fall back to downloading from github.com if the bundle is not in the toolcache.
 * 2) If a specified version of the bundle is not found, falls back to the latest bundle release.
 * 3) Adds support for a `latest-release` tools input, which forces the latest release of the bundle.
 * 4) Outputs the path to the extracted bundle and an expected code scanning configuration file.
 * 5) Ignores CodeQL version pinning.
 *
 * @param toolsInput
 * @param apiDetails
 * @param tempDir
 * @returns the path to the extracted bundle, and the version of the tools
 */
async function setupCodeQLBundleStrict(
  toolsInput: string | undefined,
  apiDetails: api.GitHubApiDetails,
  tempDir: string,
  codeqlActionRepo: string
): Promise<{
  codeqlFolder: string
  toolsDownloadDurationMs?: number
  toolsSource: ToolsSource
  toolsVersion: string
}> {
  const source = await getCodeQLSource(toolsInput, apiDetails, codeqlActionRepo)

  let codeqlFolder: string
  let toolsVersion = source.toolsVersion
  let toolsDownloadDurationMs: number | undefined
  let toolsSource: ToolsSource
  switch (source.sourceType) {
    case 'local':
      codeqlFolder = await toolcache.extractTar(source.codeqlTarPath)
      toolsSource = ToolsSource.Local
      break
    case 'toolcache':
      codeqlFolder = source.codeqlFolder
      core.info(`CodeQL found in cache ${codeqlFolder}`)
      toolsSource = ToolsSource.Toolcache
      break
    case 'download': {
      const result = await downloadCodeQL(
        source.codeqlURL,
        source.bundleVersion,
        source.cliVersion,
        apiDetails,
        tempDir
      )
      toolsVersion = result.toolsVersion
      codeqlFolder = result.codeqlFolder
      toolsDownloadDurationMs = result.toolsDownloadDurationMs
      toolsSource = ToolsSource.Download
      break
    }
    default:
      throw new Error('Unknown tools source type.')
  }
  return { codeqlFolder, toolsDownloadDurationMs, toolsSource, toolsVersion }
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const codeqlActionRepo: string = getRequiredInput('codeql-action')
    const toolsInput: string = getRequiredInput('tools')
    const apiClient = api.getApiDetails()

    try {
      const result = await setupCodeQLBundleStrict(
        toolsInput,
        apiClient,
        getTemporaryDirectory(),
        codeqlActionRepo
      )

      core.setOutput('codeql-tools-path', result.codeqlFolder)
    } catch (e) {
      throw new Error(
        `Unable to download and extract CodeQL CLI: ${wrapError(e).message}`
      )
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

import * as githubUtils from '@actions/github/lib/utils'

import consoleLogLevel from 'console-log-level'

import { getRequiredInput, getRequiredEnvParam } from './util'

export type GitHubApiCombinedDetails = GitHubApiDetails &
  GitHubApiExternalRepoDetails

export interface GitHubApiDetails {
  auth: string
  url: string
  apiURL: string | undefined
}

export interface GitHubApiExternalRepoDetails {
  externalRepoAuth?: string
  url: string
  apiURL: string | undefined
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createApiClientWithDetails(
  apiDetails: GitHubApiCombinedDetails,
  { allowExternal = false } = {}
) {
  const auth = (allowExternal && apiDetails.externalRepoAuth) || apiDetails.auth
  return new githubUtils.GitHub(
    githubUtils.getOctokitOptions(auth, {
      baseUrl: apiDetails.apiURL,
      userAgent: `CodeQL-Action-Wrapper/0.0.0}`,
      log: consoleLogLevel({ level: 'debug' })
    })
  )
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getApiDetails() {
  return {
    auth: getRequiredInput('token'),
    url: getRequiredEnvParam('GITHUB_SERVER_URL'),
    apiURL: getRequiredEnvParam('GITHUB_API_URL')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getApiClient() {
  return createApiClientWithDetails(getApiDetails())
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getApiClientWithExternalAuth(
  apiDetails: GitHubApiCombinedDetails
) {
  return createApiClientWithDetails(apiDetails, { allowExternal: true })
}

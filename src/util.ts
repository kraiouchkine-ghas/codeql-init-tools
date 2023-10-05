import * as core from '@actions/core'

export function wrapError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Get an environment parameter, but throw an error if it is not set.
 */
export function getRequiredEnvParam(paramName: string): string {
  const value = process.env[paramName]
  if (value === undefined || value.length === 0) {
    throw new Error(`${paramName} environment variable must be set`)
  }
  return value
}

/**
 * Wrapper around core.getInput for inputs that always have a value.
 * Also see getOptionalInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
export function getRequiredInput(name: string): string {
  const value = core.getInput(name)
  if (!value) {
    throw new Error(`Input required and not supplied: ${name}`)
  }
  return value
}

/**
 * Wrapper around core.getInput that converts empty inputs to undefined.
 * Also see getRequiredInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
export function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name)
  return value.length > 0 ? value : undefined
}

export function getTemporaryDirectory(): string {
  const value = process.env['CODEQL_ACTION_TEMP']
  return value !== undefined && value !== ''
    ? value
    : getRequiredEnvParam('RUNNER_TEMP')
}

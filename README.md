# CodeQL Wrapper Action: CodeQL Tool Initialization

The `codeql-init-tools` action, used by the CodeQL Wraper Action's `init` action, provides a custom implementation of the default `init` action's CodeQL tools resolution and caching logic. On GitHub Enterprise Server in particular, this action provides strictier control over the precise CodeQL tools bundle used for analysis and omits certain implicit behaviors present in the default `init` action, such as falling back to downloading the latest CodeQL tools bundle from GitHub.com if a specified bundle is not found.

## License

This project is released under the [MIT License](LICENSE).

The underlying CodeQL CLI, used by the CodeQL Action this wrapper action encapsulates, is licensed under the [GitHub CodeQL Terms and Conditions](https://securitylab.github.com/tools/codeql/license). As such, this action may be used on open source projects hosted on GitHub, and on private repositories that are owned by an organisation with GitHub Advanced Security enabled.

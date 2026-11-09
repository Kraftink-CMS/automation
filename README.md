# KraftInk Automation

Shared release tooling for Kraftink-CMS plugins, themes, game modules, and projects with custom builds.

## Publish a release

1. Push your changes to `dev`.
2. In your repository, open **Actions → Release → Run workflow**.
3. Choose `auto`, `patch`, `minor`, or `major` and run the workflow.

Write access to your project repository is enough to start a release. The workflow uses GitHub’s built-in token.

The scheduled repository controller installs the **Release** workflow and branch protections. New projects are set up on its next run. The controller recognizes standalone plugins, themes, and game modules by the repository name patterns `Plugin-*`, `Theme-*`, and `Game-*`.

The installed **Release** wrapper provides the GitHub Actions configuration for standard plugins, themes, and game modules. Projects with a custom build, such as KraftLink’s Maven build, also supply `.github/actions/build/action.yml`.

The wrapper runs the same validation for pull requests targeting `dev` and for releases. Pull request builds use temporary files. The required **checks / Validate changes** check blocks merges into `dev` on failure. Users with the GitHub **Maintain** or **Admin** role can bypass that branch rule and push directly to `dev`. Release validation must pass for every user. The automation verifies that version-only commits change only release metadata.

To run project tests, add the optional composite action `.github/actions/test/action.yml`. Shared validation runs it before the build for pull requests and releases, using a read-only token. Set the working directory to the project root (`${{ github.action_path }}/../../..`), install the test environment, and run the commands your project uses, such as `npm test` or PHPUnit. A failing test blocks validation. KraftLink’s Maven build already runs its tests.

Each release run prepares the stable version on `dev` and opens a pull request into `master` before the build. A read-only job validates the source and builds the files. The workflow then merges the validated pull request and publishes the release. These steps run in your project repository. If the build fails, the pull request stays open and publication stops. A new release request is blocked while a release pull request is open, and the workflow links to it.

By default, the first stable release uses the version declared by the project, with the development suffix removed. For later releases, `auto` uses Conventional Commits to choose the version bump. You can also choose a bump explicitly. The `.github/release-policy.json` file is optional.

Use `notes_mode` to choose how the workflow uses the Markdown `notes` field.

- `auto` generates the commit list. Leave `notes` empty.
- `append` puts your message before the generated list.
- `replace` uses your message as the complete release notes.

`append` and `replace` require a message of up to 8 KiB in UTF-8. The generated list includes up to 100 commits since the previous stable release, plus a comparison link. It excludes bot, merge, and release metadata commits. Rerunning failed jobs keeps the prepared notes and preserves the notes of an already published release. Custom builds use the same options.

`master` holds the published stable version. After publication, `dev` advances to the next patch version with the `-dev` suffix. Run `git pull` before continuing development.

For a temporary error on the same source, use **Re-run failed jobs** in the original **Release** run. To fix the code before the merge, push the fix to `dev` and use **Re-run all jobs** in that same run. This prepares the source again and rebuilds it with the version already selected. To change the target version, close the pull request and start a new **Release** run. Finish any publication interrupted after its merge before starting the next release.

The workflow retains the release context and temporary artifacts for seven days. Published files are immutable. The Market picks up the release on its next refresh.

## Publish custom build files

To use the same **Release** workflow with a custom build, set up these files on `dev`.

1. Copy the [Release wrapper](templates/workflow-templates/extension-release.yml) to `.github/workflows/release.yml`.
2. Add a composite action at `.github/actions/build/action.yml` with the `version` and `output-directory` inputs.
3. In that action, set up the build environment and write the release files to the supplied absolute `output-directory`.

Pull requests targeting `dev` use the current source version, which may end in `-dev`. Releases use the prepared stable version. Files built for a pull request stay in the runner’s temporary storage.

The controller installs the **Release** workflow on `master`. The next run checks out the prepared stable source and runs your build action with a read-only token. Automation handles the version, release pull request, checksums, and publication.

These repositories require a pull request and the GitHub Actions status `Release validated source` to merge into `master`. The workflow posts that status after building and verifying the source. Contributors with write access can also merge a validated pull request or edit the repository’s workflows. Branch protection prevents force pushes and deletion of `master`.

An existing workflow can also call `Kraftink-CMS/automation@master` directly.

- `operation: plan` returns `version` and `plan-path`.
- `operation: publish` takes that `plan-path`, the `artifacts-path` directory, and the workflow’s `github-token`. Grant the token `contents: write` and `statuses: write` so the action can publish the release and start the next development cycle.

## Development

Local development requires Node.js 24, PHP 8.5, Composer 2, and Git.

```shell
npm ci --ignore-scripts
composer install --working-dir=scripts/releases/php-scoper --no-interaction --prefer-dist --no-progress --no-scripts --no-plugins
npm test
```

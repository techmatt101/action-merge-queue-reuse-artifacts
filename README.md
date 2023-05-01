# Merge Queue reuse Artifacts Github Action

This github action allows merge queue workflows to reuse artifacts from a previous pull request workflow when branch is not behind.
When `merge_group` workflow runs for a pull request with a matching base sha and a completed workflow, the action will download all artifacts from the previous workflow and upload them to the current workflow, allowing the build steps to be skipped. If the pull request branch is out of date with the default branch, then the action will be skipped, requring the workflow to run build steps.

## Motivation

When using a merge queue workflow, it is common to have a workflow that builds and tests the code as part of the pull request, and then a second workflow for the merge queue. If the pull request branch base is the same as the default branch, then the build and test workflow will be run twice, once for the pull request and once for the merge. This action allows the merge queue workflow to reuse the artifacts from the pull request workflow, saving time and resources.



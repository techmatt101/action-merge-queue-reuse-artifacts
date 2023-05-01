import { info, debug, warning, setFailed, setOutput, getInput } from "@actions/core";
import { getOctokit } from "@actions/github";
import { create as createArtifactClient } from "@actions/artifact";
import { mkdirSync } from "fs";
import AdmZip from "adm-zip";

async function main(): Promise<void> {
  try {
    if (process.env.GITHUB_EVENT_NAME !== "merge_group") {
      warning("Only merge_group event is supported, skipping.");
      setOutputs(false);
      return;
    }

    const workflowId = getInput("workflow-id", { required: true });

    const ref = process.env.GITHUB_REF!;
    const client = getOctokit(process.env.GITHUB_TOKEN!);
    const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

    const matches = ref.match(/pr-(\d+)-(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error(`Failed to parse ref: ${ref}`);
    }

    const pullNumber = parseInt(matches[1], 10);
    const baseSha = matches[2];

    info(`Base SHA: ${baseSha}`);
    info(`Pull Request Number: ${pullNumber}`);

    const prResponse = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const prBaseSha = prResponse.data.base.sha;
    const prHeadSha = prResponse.data.head.sha;

    info(`Pull Request Base SHA: ${prBaseSha}`);
    info(`Pull Request Head SHA: ${prHeadSha}`);

    if (baseSha !== prBaseSha) {
      info("Base SHA does not match Pull Request base SHA, skipping artifact download.");
      setOutputs(false);
      return;
    }

    const workflowResponse = await client.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, per_page: 1, head_sha: prHeadSha });
    const workflowRun = workflowResponse.data.workflow_runs[0];

    if (!workflowRun || workflowRun.status !== "completed") {
      warning("No completed workflow run found.");
      setOutputs(false);
      return;
    }

    info(`Workflow ID: ${workflowRun.id} (${workflowRun.status} ${workflowRun.conclusion})`);

    const artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
      owner: owner,
      repo: repo,
      run_id: workflowRun.id
    });

    const artifactClient = createArtifactClient();

    for (const artifact of artifacts) {
      const artifactDir = "./" + artifact.name;

      info(`=> Downloading artifact: ${artifact.name} to ${artifactDir}`);

      const zip = (await client.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifact.id,
        archive_format: "zip"
      })) as { data: Buffer };

      debug(`=> Extracting: ${artifact.name}.zip`);
      const adm = new AdmZip(Buffer.from(zip.data));
      mkdirSync(artifact.name, { recursive: true });

      const files = adm
        .getEntries()
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.entryName);

      files.forEach((file) => debug(`  ${file}`));

      adm.extractAllTo(artifactDir, true);
      info(`=> Uploading artifact: ${artifact.name}`);

      await artifactClient.uploadArtifact(artifact.name, files, artifactDir);
    }

    setOutputs(true);
    info(`${artifacts.length} artifacts successfully copied from run ${workflowRun.id}.`);
  } catch (error: any) {
    setOutputs(false);
    setFailed(error.message);
  }
}

function setOutputs(passed: boolean): void {
  setOutput("artifacts-reused", passed);
}

main();

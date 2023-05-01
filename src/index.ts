import { info, setOutput, getInput } from "@actions/core";
import { getOctokit } from "@actions/github";
import { create as createArtifactClient } from "@actions/artifact";
import { mkdirSync } from "fs";
import AdmZip from "adm-zip";

async function main(): Promise<void> {
  const workflowId = getInput("workflow-id", { required: true });

  const ref = process.env.GITHUB_REF!;
  const client = getOctokit(process.env.GITHUB_TOKEN!);
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

  const matches = ref.match(/pr-(\d+)-(.+)$/)!;
  const pullNumber = parseInt(matches[1], 10);
  const baseSha = matches[2];

  const prResponse = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const prBaseSha = prResponse.data.base.sha;
  const prHeadSha = prResponse.data.head.sha;

  if (baseSha !== prBaseSha) {
    info("Base SHA does not match Pull Request base SHA, skipping artifact download.");
    setOutputs(false);
    return;
  }

  const workflowResponse = await client.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, per_page: 1, head_sha: prHeadSha });
  const workflowRun = workflowResponse.data.workflow_runs[0];

  const artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
    owner: owner,
    repo: repo,
    run_id: workflowRun.id
  });

  const artifactClient = createArtifactClient();

  for (const artifact of artifacts) {
    const artifactDir = "./" + artifact.name;

    const zip = (await client.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip"
    })) as { data: Buffer };

    const adm = new AdmZip(Buffer.from(zip.data));
    mkdirSync(artifact.name, { recursive: true });

    const files = adm
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.entryName);

    adm.extractAllTo(artifactDir, true);
    await artifactClient.uploadArtifact(artifact.name, files, artifactDir);
  }

  setOutputs(true);
}

function setOutputs(passed: boolean): void {
  setOutput("artifacts-reused", passed);
}

main();

import { info, debug, warning, setFailed, setOutput, getInput } from "@actions/core";
import { getOctokit } from "@actions/github";
import { DefaultArtifactClient } from "@actions/artifact";
import { mkdirSync } from "fs";
import path from "path";
import AdmZip from "adm-zip";

async function main(): Promise<void> {
  try {
    if (process.env.GITHUB_EVENT_NAME !== "merge_group") {
      warning("Only merge_group event is supported, skipping.");
      setOutputs(false);
      return;
    }

    const token = getInput("github-token", { required: true });
    const workflowId = getInput("workflow-id", { required: true });
    const outputPath = getInput("path", { required: false });
    const retentionDaysInput = getInput("retention-days", { required: false });

    const ref = process.env.GITHUB_REF!;
    const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
    const client = getOctokit(token);

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
      info("Base SHA does not match Pull Request base SHA, skipping.");
      setOutputs(false);
      return;
    }

    const workflowResponse = await client.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, per_page: 1, head_sha: prHeadSha });
    const workflowRun = workflowResponse.data.workflow_runs[0];

    if (!workflowRun) {
      warning(`No '${workflowId}' workflow run found for ${prHeadSha}.`);
      setOutputs(false);
      return;
    }

    if (workflowRun.status !== "completed") {
      warning(`Workflow ${workflowRun.id} has not completed (${workflowRun.status}).`);
      setOutputs(false);
      return;
    }

    info(`Workflow ID: ${workflowRun.id} (${workflowRun.status} ${workflowRun.conclusion})`);

    const artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
      owner: owner,
      repo: repo,
      run_id: workflowRun.id
    });

    const artifactClient = new DefaultArtifactClient();
    const artifactsUnpacked: { name: string; root: string; files: string[]; createdAt: string | null, expiresAt: string | null }[] = [];

    const expiredArtifacts = artifacts.filter((x) => x.expired);
    if (expiredArtifacts.length > 0) {
      warning(`${expiredArtifacts.join(", ")} artifact has/have expired, aborting.`);
      setOutputs(false);
      return;
    }

    for (const artifact of artifacts) {
      const artifactDir = path.join(outputPath, artifact.name);
      info(`=> Downloading artifact: ${artifact.name} to ${artifactDir}`);

      let zip: { data: Buffer };
      try {
        zip = (await client.rest.actions.downloadArtifact({
          owner,
          repo,
          artifact_id: artifact.id,
          archive_format: "zip"
        })) as any;
      } catch (error: any) {
        if (error.message === "Artifact has expired") {
          warning(`${artifact.name} artifact has expired, aborting.`);
          setOutputs(false);
          return;
        } else {
          error(`Failed to download artifact: ${artifact.name}`);
          throw new Error(error.message);
        }
      }

      debug(`=> Extracting: ${artifact.name}.zip`);
      const adm = new AdmZip(Buffer.from(zip.data));
      mkdirSync(artifact.name, { recursive: true });

      const files = adm
        .getEntries()
        .filter((entry) => !entry.isDirectory)
        .map((entry) => path.join(artifactDir, entry.entryName));

      files.forEach((file) => debug(`  ${file}`));
      adm.extractAllTo(artifactDir, true);

      artifactsUnpacked.push({
        name: artifact.name,
        root: artifactDir,
        createdAt: artifact.created_at,
        expiresAt: artifact.expires_at,
        files
      });
    }

    for (const artifact of artifactsUnpacked) {
      let retentionDays = 0;
      if (retentionDaysInput === "match") {
        if (!artifact.createdAt || !artifact.expiresAt) {
          warning(`Unable to calcuate retention days for ${artifact.name} artifact as it has no created_at or expires_at. Using default retention.`);
        } else {
          retentionDays = Math.round((new Date(artifact.expiresAt).getTime() - new Date(artifact.createdAt).getTime()) / 1000 / 60 / 60 / 24);
        }
      } else if (retentionDaysInput !== "default") {
        retentionDays = parseInt(retentionDaysInput, 10);
      }

      info(`=> Uploading artifact: ${artifact.name} (${retentionDays} retention days)`);
      await artifactClient.uploadArtifact(artifact.name, artifact.files, artifact.root, { retentionDays: retentionDays });
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
  info(`artifacts-reused: ${passed ? "true" : "false"}`);
}

main();

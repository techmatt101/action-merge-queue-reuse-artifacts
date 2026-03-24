import { info, debug, warning, error, setFailed, setOutput, getInput, startGroup, endGroup } from "@actions/core";
import { getOctokit } from "@actions/github";
import { DefaultArtifactClient } from "@actions/artifact";
import { mkdirSync } from "fs";
import path from "path";
import AdmZip from "adm-zip";
import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";

type Inputs = {
  token: string;
  workflowId: string;
  outputPath: string;
  retentionDaysInput: string;
  compressionLevelInput: number;
};

type RepoContext = {
  ref: string;
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
};

type UnpackedArtifact = {
  name: string;
  root: string;
  files: string[];
  createdAt: string | null;
  expiresAt: string | null;
};

type WorkflowArtifact = RestEndpointMethodTypes["actions"]["listWorkflowRunArtifacts"]["response"]["data"]["artifacts"][number];

class ExpiredArtifactError extends Error {}

function getInputs(): Inputs {
  return {
    token: getInput("github-token", { required: true }),
    workflowId: getInput("workflow-id", { required: true }),
    outputPath: getInput("path", { required: false }),
    retentionDaysInput: getInput("retention-days", { required: false }),
    compressionLevelInput: parseInt(getInput("compression-level", { required: false }))
  };
}

function getPrContext(): RepoContext {
  const ref = process.env.GITHUB_REF!;
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  const matches = ref.match(/pr-(\d+)-(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error(`Failed to parse ref: ${ref}`);
  }

  const pullNumber = parseInt(matches[1], 10);
  const baseSha = matches[2];

  return { ref, owner, repo, pullNumber, baseSha };
}

function filterOutOldArtifacts(workflowArtifacts: WorkflowArtifact[]): WorkflowArtifact[] {
  const artifactsMap = new Map<string, WorkflowArtifact>();

  for (const artifact of workflowArtifacts) {
    if (!artifactsMap.has(artifact.name)) {
      artifactsMap.set(artifact.name, artifact);
    } else {
      const existing = artifactsMap.get(artifact.name)!;
      if (new Date(artifact.created_at!).getTime() > new Date(existing.created_at!).getTime()) {
        info(
          `Filtering out older artifact ${existing.name} (ID: ${existing.id}) created_at: ${existing.created_at} because a newer version (ID: ${artifact.id}, created_at: ${artifact.created_at}) is available.`
        );
        artifactsMap.set(artifact.name, artifact);
      } else {
        info(
          `Filtering out older artifact ${artifact.name} (ID: ${artifact.id}) created_at: ${artifact.created_at} because a newer version (ID: ${existing.id}, created_at: ${existing.created_at}) is available.`
        );
      }
    }
  }

  return Array.from(artifactsMap.values());
}

async function downloadArtifact(
  client: ReturnType<typeof getOctokit>,
  artifact: WorkflowArtifact,
  owner: string,
  repo: string,
  outputPath: string
): Promise<UnpackedArtifact> {
  const artifactDir = path.join(outputPath, artifact.name);
  startGroup(`=> Downloading artifact: ${artifact.id} (${artifact.name}) to ./${artifactDir}`);

  let zip: { data: Buffer };
  try {
    zip = (await client.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip"
    })) as any;
  } catch (e: any) {
    if (e.message === "Artifact has expired") {
      warning(`${artifact.name} artifact has expired, aborting.`);
      throw new ExpiredArtifactError(e.message);
    } else {
      error(`Failed to download artifact: ${artifact.name}`);
      throw new Error(e.message);
    }
  }

  debug(`Extracting: ./${artifact.name}.zip to ./${artifactDir}`);
  const adm = new AdmZip(Buffer.from(zip.data));
  mkdirSync(artifact.name, { recursive: true });

  const files = adm
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => path.join(artifactDir, entry.entryName));

  files.forEach((file) => debug(`  ${file}`));
  adm.extractAllTo(artifactDir, true);

  info(`Artifact ${artifact.name} successfully finalized.`);
  endGroup();

  return {
    name: artifact.name,
    root: artifactDir,
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
    files
  };
}

async function uploadArtifacts(
  artifactClient: DefaultArtifactClient,
  artifact: UnpackedArtifact,
  retentionDaysInput: string,
  compressionLevelInput: number
): Promise<void> {
  const retentionDays = getRetentionDays(artifact, retentionDaysInput);

  startGroup(`=> Uploading artifact: ${artifact.name}`);
  info(`Retention days: ${retentionDays}`);
  info(`Compression Level: ${compressionLevelInput}`);
  await artifactClient.uploadArtifact(artifact.name, artifact.files, artifact.root, { retentionDays: retentionDays, compressionLevel: compressionLevelInput });
  endGroup();
}

function getRetentionDays(artifact: UnpackedArtifact, retentionDaysInput: string): number {
  let retentionDays = 0;
  if (retentionDaysInput === "match") {
    if (!artifact.createdAt || !artifact.expiresAt) {
      warning(`Unable to calculate retention days for ${artifact.name} artifact. No created_at or expires_at. Using default retention.`);
    } else {
      retentionDays = Math.round((new Date(artifact.expiresAt).getTime() - new Date(artifact.createdAt).getTime()) / 1000 / 60 / 60 / 24);
    }
  } else if (retentionDaysInput !== "default") {
    retentionDays = parseInt(retentionDaysInput, 10);
  }

  return retentionDays;
}

async function main(): Promise<void> {
  try {
    if (process.env.GITHUB_EVENT_NAME !== "merge_group") {
      warning("Only merge_group event is supported, skipping.");
      setOutputs(false);
      return;
    }

    const { token, workflowId, outputPath, retentionDaysInput, compressionLevelInput } = getInputs();
    const { owner, repo, pullNumber, baseSha } = getPrContext();
    const client = getOctokit(token);

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

    info(`Workflow ID: ${workflowRun.id} Run Number: ${workflowRun.run_number} Status: ${workflowRun.status} Conclusion: ${workflowRun.conclusion}`);

    const workflowArtifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
      owner: owner,
      repo: repo,
      run_id: workflowRun.id
    });

    const artifacts = filterOutOldArtifacts(workflowArtifacts);

    const expiredArtifacts = artifacts.filter((x) => x.expired);
    if (expiredArtifacts.length > 0) {
      warning(`${expiredArtifacts.join(", ")} artifact has/have expired, aborting.`);
      setOutputs(false);
      return;
    }

    for (const artifact of artifacts) {
      info(`+ Artifact ${artifact.name} found. ID: ${artifact.id} Expires At: ${artifact.expires_at} Size: ${artifact.size_in_bytes}`);
    }

    const artifactClient = new DefaultArtifactClient();
    const artifactsUnpacked: UnpackedArtifact[] = [];

    for (const artifact of artifacts) {
      try {
        artifactsUnpacked.push(await downloadArtifact(client, artifact, owner, repo, outputPath));
      } catch (error: any) {
        if (error instanceof ExpiredArtifactError) {
          setOutputs(false);
          return;
        }

        throw error;
      }
    }

    for (const artifact of artifactsUnpacked) {
      await uploadArtifacts(artifactClient, artifact, retentionDaysInput, compressionLevelInput);
    }

    setOutputs(true);
    info(`${artifacts.length} artifacts successfully copied from workflow ${workflowRun.id}.`);
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

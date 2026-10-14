// Compile-only example: resolves types from the independently installed npm tarball.
import {
  GPULinkClient,
  type JobSubmission,
  type SessionRequest,
  type DataPlaneConnectOptions,
  type GPULinkDataPlane,
} from '@gpulink/client';

const client = new GPULinkClient({ baseUrl: 'https://gpulink.example.invalid', token: 'example-token' });
const finiteJob: JobSubmission = { projectId: 'example', type: 'diagnostic.gpu-status' };
const session: SessionRequest = { projectId: 'example', capability: 'speech.streaming' };
const connectOptions: DataPlaneConnectOptions = { protocolVersion: 2, connectTimeoutMs: 5_000 };
const jobResult: Promise<{ job: { id: string }; duplicate: boolean }> = client.submitJob(finiteJob);
const sessionResult = client.requestSession(session);
const streamingResult: Promise<GPULinkDataPlane> = client.connectSession('session-id', connectOptions);
void [jobResult, sessionResult, streamingResult];

import {
  SyncConflictError,
  SyncError,
  parseEncryptedSyncBundle,
  parseEncryptedSyncDescriptor,
  syncError,
  type EncryptedSyncBundle,
  type EncryptedSyncDescriptor,
  type RemoteEncryptedProject,
  type RemoteSyncRecord,
  type SyncAdapter,
  type SyncConnectionIdentity,
  type SyncDeleteInput,
  type SyncUploadInput,
} from './sync-domain.js';

export const SYNC_DESCRIPTOR_FILE = 'zuocheng-sync.json';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const ACCEPT = 'application/vnd.github+json';
const GIST_DESCRIPTION = '做成项目同步';
const MAX_LIST_PAGES = 10;
const PAGE_SIZE = 100;
const MAX_REQUEST_CHARACTERS = 96 * 1024 * 1024;
const GIST_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const MANAGED_PAYLOAD_PATH =
  /^payload-[a-zA-Z0-9._-]{1,80}\.txt$/u;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface GistFile {
  filename: string;
  content: string | null;
  truncated: boolean;
}

interface FetchedGist {
  id: string;
  etag: string | null;
  updatedAt: string;
  files: Record<string, GistFile>;
}

export interface GitHubGistSyncAdapterOptions {
  fetcher?: Fetcher;
}

export class GitHubGistSyncAdapter implements SyncAdapter {
  readonly #fetcher: Fetcher;

  constructor(options: GitHubGistSyncAdapterOptions = {}) {
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async verifyConnection(
    token: string,
    signal: AbortSignal,
  ): Promise<SyncConnectionIdentity> {
    const response = await this.#request(
      '/user',
      token,
      { method: 'GET', signal },
    );
    const object = await responseObject(response);
    if (
      typeof object.login !== 'string' ||
      object.login.length === 0 ||
      typeof object.id !== 'number' ||
      !Number.isSafeInteger(object.id)
    ) {
      throw new SyncError(
        'INVALID_RESPONSE',
        'GitHub 返回了无法识别的账号信息。',
      );
    }
    return { login: object.login, userId: object.id };
  }

  async listProjects(
    token: string,
    signal: AbortSignal,
  ): Promise<RemoteSyncRecord[]> {
    const records: RemoteSyncRecord[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const response = await this.#request(
        `/gists?per_page=${PAGE_SIZE}&page=${page}`,
        token,
        { method: 'GET', signal },
      );
      const summaries = await responseArray(response);
      for (const value of summaries) {
        const summary = objectAt(value);
        const id = gistIdAt(summary.id);
        const files = objectAt(summary.files);
        if (files[SYNC_DESCRIPTOR_FILE] === undefined) {
          continue;
        }
        try {
          const gist = await this.#fetchGist(token, id, signal);
          const descriptor = descriptorFromGist(gist);
          records.push(recordFrom(gist, descriptor));
        } catch (error) {
          const mapped = syncError(error, 'INVALID_RESPONSE');
          if (mapped.code === 'CANCELLED') {
            throw mapped;
          }
          // Ignore unrelated or older malformed gists without hiding a
          // transport or account failure from the user.
          if (
            mapped.code !== 'INVALID_RESPONSE' &&
            mapped.code !== 'NOT_FOUND'
          ) {
            throw mapped;
          }
        }
      }
      if (summaries.length < PAGE_SIZE) {
        break;
      }
    }
    return records.sort(
      (left, right) =>
        right.projectUpdatedAt.localeCompare(left.projectUpdatedAt) ||
        left.projectId.localeCompare(right.projectId),
    );
  }

  async fetchProject(
    token: string,
    gistId: string,
    signal: AbortSignal,
  ): Promise<RemoteEncryptedProject> {
    const gist = await this.#fetchGist(token, gistIdAt(gistId), signal);
    const descriptor = descriptorFromGist(gist);
    const encryptedFiles: Record<string, string> = {};
    for (const path of descriptor.payload.chunkPaths) {
      const file = gist.files[path];
      if (
        file === undefined ||
        file.truncated ||
        file.content === null
      ) {
        throw new SyncError(
          'INVALID_RESPONSE',
          '远端项目内容不完整，无法拉取。',
        );
      }
      encryptedFiles[path] = file.content;
    }
    return {
      record: recordFrom(gist, descriptor),
      bundle: parseEncryptedSyncBundle({
        descriptor,
        encryptedFiles,
      }),
    };
  }

  async uploadProject(
    input: SyncUploadInput,
  ): Promise<RemoteSyncRecord> {
    const bundle = parseEncryptedSyncBundle(input.bundle);
    const files = filesForBundle(bundle);
    if (JSON.stringify(files).length > MAX_REQUEST_CHARACTERS) {
      throw new SyncError(
        'PAYLOAD_TOO_LARGE',
        '加密项目包超过 GitHub Gist 请求上限。',
      );
    }
    if (input.gistId === undefined) {
      const response = await this.#request('/gists', input.token, {
        method: 'POST',
        signal: input.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files,
        }),
      });
      const gist = await gistFromResponse(response);
      return recordFrom(gist, bundle.descriptor);
    }
    const gistId = gistIdAt(input.gistId);
    if (input.expectedRevision === undefined) {
      throw new SyncError(
        'INVALID_INPUT',
        '更新远端项目时缺少修订基线。',
      );
    }
    const current = await this.#fetchGist(
      input.token,
      gistId,
      input.signal,
    );
    const currentDescriptor = descriptorFromGist(current);
    if (currentDescriptor.revision !== input.expectedRevision) {
      throw new SyncConflictError({
        kind: 'remote_changed',
        projectId: currentDescriptor.projectId,
        localVersion: bundle.descriptor.projectVersion,
        localUpdatedAt: bundle.descriptor.projectUpdatedAt,
        remoteVersion: currentDescriptor.projectVersion,
        remoteUpdatedAt: currentDescriptor.projectUpdatedAt,
        remoteRevision: currentDescriptor.revision,
        gistId,
      });
    }
    const updateFiles: Record<
      string,
      { content: string } | null
    > = { ...files };
    const nextPaths = new Set(Object.keys(files));
    for (const path of Object.keys(current.files)) {
      if (
        isManagedPath(path) &&
        !nextPaths.has(path)
      ) {
        updateFiles[path] = null;
      }
    }
    const response = await this.#request(
      `/gists/${encodeURIComponent(gistId)}`,
      input.token,
      {
        method: 'PATCH',
        signal: input.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(current.etag === null
            ? {}
            : { 'If-Match': current.etag }),
        },
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          files: updateFiles,
        }),
      },
    );
    const updated = await gistFromResponse(response);
    return recordFrom(updated, bundle.descriptor);
  }

  async deleteProject(input: SyncDeleteInput): Promise<void> {
    const gistId = gistIdAt(input.gistId);
    const current = await this.#fetchGist(
      input.token,
      gistId,
      input.signal,
    );
    const descriptor = descriptorFromGist(current);
    if (descriptor.revision !== input.expectedRevision) {
      throw new SyncConflictError({
        kind: 'remote_changed',
        projectId: descriptor.projectId,
        localVersion: null,
        localUpdatedAt: null,
        remoteVersion: descriptor.projectVersion,
        remoteUpdatedAt: descriptor.projectUpdatedAt,
        remoteRevision: descriptor.revision,
        gistId,
      });
    }
    await this.#request(
      `/gists/${encodeURIComponent(gistId)}`,
      input.token,
      {
        method: 'DELETE',
        signal: input.signal,
        ...(current.etag === null
          ? {}
          : { headers: { 'If-Match': current.etag } }),
      },
    );
  }

  async #fetchGist(
    token: string,
    gistId: string,
    signal: AbortSignal,
  ): Promise<FetchedGist> {
    const response = await this.#request(
      `/gists/${encodeURIComponent(gistId)}`,
      token,
      { method: 'GET', signal },
    );
    return gistFromResponse(response);
  }

  async #request(
    path: string,
    token: string,
    init: RequestInit,
  ): Promise<Response> {
    const credential = tokenAt(token);
    let response: Response;
    try {
      response = await this.#fetcher(`${API_ROOT}${path}`, {
        ...init,
        headers: {
          Accept: ACCEPT,
          Authorization: `Bearer ${credential}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...headersObject(init.headers),
        },
      });
    } catch (error) {
      throw syncError(error);
    }
    if (response.ok) {
      return response;
    }
    if (response.status === 401) {
      throw new SyncError(
        'AUTH_FAILED',
        'GitHub 连接已失效，请重新填写访问令牌。',
      );
    }
    if (
      response.status === 403 &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number(
        response.headers.get('x-ratelimit-reset'),
      );
      throw new SyncError(
        'RATE_LIMITED',
        'GitHub 请求次数已达上限，请稍后再试。',
        Number.isFinite(reset)
          ? {
              retryAfterAt: new Date(reset * 1_000).toISOString(),
            }
          : {},
      );
    }
    if (response.status === 403) {
      throw new SyncError(
        'FORBIDDEN',
        '当前访问令牌没有 Gist 读写权限。',
      );
    }
    if (response.status === 404) {
      throw new SyncError(
        'NOT_FOUND',
        '远端项目不存在或当前账号无权访问。',
      );
    }
    if (response.status === 409 || response.status === 412) {
      throw new SyncError(
        'CONFLICT',
        '远端内容已变化，请刷新后重新选择。',
      );
    }
    if (response.status === 413 || response.status === 422) {
      throw new SyncError(
        'PAYLOAD_TOO_LARGE',
        '远端拒绝了当前项目包，请检查项目大小。',
      );
    }
    throw new SyncError(
      'NETWORK',
      `GitHub 请求未完成（${response.status}）。`,
    );
  }
}

function filesForBundle(
  bundle: EncryptedSyncBundle,
): Record<string, { content: string }> {
  const files: Record<string, { content: string }> = {
    [SYNC_DESCRIPTOR_FILE]: {
      content: `${JSON.stringify(bundle.descriptor, null, 2)}\n`,
    },
  };
  for (const path of bundle.descriptor.payload.chunkPaths) {
    const content = bundle.encryptedFiles[path];
    if (content === undefined) {
      throw new SyncError(
        'INVALID_INPUT',
        '加密项目包缺少内容分片。',
      );
    }
    files[path] = { content };
  }
  return files;
}

function descriptorFromGist(
  gist: FetchedGist,
): EncryptedSyncDescriptor {
  const file = gist.files[SYNC_DESCRIPTOR_FILE];
  if (
    file === undefined ||
    file.truncated ||
    file.content === null
  ) {
    throw new SyncError(
      'INVALID_RESPONSE',
      '远端项目索引不完整。',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch (error) {
    throw new SyncError(
      'INVALID_RESPONSE',
      '远端项目索引不是有效 JSON。',
      { cause: error },
    );
  }
  return parseEncryptedSyncDescriptor(value);
}

function recordFrom(
  gist: FetchedGist,
  descriptor: EncryptedSyncDescriptor,
): RemoteSyncRecord {
  return {
    gistId: gist.id,
    etag: gist.etag,
    revision: descriptor.revision,
    projectId: descriptor.projectId,
    projectVersion: descriptor.projectVersion,
    projectUpdatedAt: descriptor.projectUpdatedAt,
    encryptedAt: descriptor.encryptedAt,
    encryptedBytes: descriptor.payload.ciphertextBytes,
    lastModifiedAt: gist.updatedAt,
  };
}

async function gistFromResponse(
  response: Response,
): Promise<FetchedGist> {
  const object = await responseObject(response);
  const filesObject = objectAt(object.files);
  const files: Record<string, GistFile> = {};
  for (const [path, value] of Object.entries(filesObject)) {
    const file = objectAt(value);
    const content =
      typeof file.content === 'string' ? file.content : null;
    files[path] = {
      filename:
        typeof file.filename === 'string' ? file.filename : path,
      content,
      truncated: file.truncated === true,
    };
  }
  return {
    id: gistIdAt(object.id),
    etag: response.headers.get('etag'),
    updatedAt: canonicalRemoteDate(object.updated_at),
    files,
  };
}

async function responseObject(
  response: Response,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new SyncError(
      'INVALID_RESPONSE',
      'GitHub 返回了无法读取的数据。',
      { cause: error },
    );
  }
  return objectAt(value);
}

async function responseArray(response: Response): Promise<unknown[]> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new SyncError(
      'INVALID_RESPONSE',
      'GitHub 返回了无法读取的数据。',
      { cause: error },
    );
  }
  if (!Array.isArray(value)) {
    throw new SyncError(
      'INVALID_RESPONSE',
      'GitHub 返回的项目列表格式无效。',
    );
  }
  return value;
}

function objectAt(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncError(
      'INVALID_RESPONSE',
      'GitHub 返回的数据格式无效。',
    );
  }
  return value as Record<string, unknown>;
}

function gistIdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !GIST_ID.test(value)
  ) {
    throw new SyncError(
      'INVALID_RESPONSE',
      '远端项目标识无效。',
    );
  }
  return value;
}

function tokenAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 512 ||
    value !== value.trim()
  ) {
    throw new SyncError('INVALID_CREDENTIAL', '访问令牌格式无效。');
  }
  return value;
}

function canonicalRemoteDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SyncError(
      'INVALID_RESPONSE',
      '远端更新时间无效。',
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new SyncError(
      'INVALID_RESPONSE',
      '远端更新时间无效。',
    );
  }
  return date.toISOString();
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function isManagedPath(path: string): boolean {
  return (
    path === SYNC_DESCRIPTOR_FILE ||
    MANAGED_PAYLOAD_PATH.test(path)
  );
}

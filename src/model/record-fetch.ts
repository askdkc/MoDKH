let recordingProxy: string | undefined;

export function configureHttpModelRecording(proxyUrl: string | undefined): void {
  const proxy = URL.parse(proxyUrl ?? '');
  recordingProxy = proxy?.protocol === 'http:' && proxy.hostname === '127.0.0.1' &&
    !proxy.username && !proxy.password ? proxy.origin : undefined;
}

export function forwardsLocalModel(target: URL): boolean {
  return !!recordingProxy && (target.protocol === 'https:' || target.protocol === 'http:') &&
    !target.username && !target.password && target.origin !== recordingProxy;
}

function recordedFetch(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, local: boolean): Promise<Response> {
  if (!recordingProxy) return fetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const method = init?.method ?? request?.method;
  const target = URL.parse(request?.url ?? String(input));
  if (method?.toUpperCase() !== 'POST' || !target || !forwardsLocalModel(target) ||
      (!local && target.protocol !== 'http:')) return fetch(input, init);

  // AgenticReplay connects to this origin using its original scheme and TLS verification.
  const destination = `${recordingProxy}/forward/${encodeURIComponent(target.origin)}${target.pathname}${target.search}`;
  return fetch(request ? new Request(destination, request) : destination, init);
}

export const fetchModel: typeof fetch = (input, init) => recordedFetch(input, init, false);
export const fetchLocalModel: typeof fetch = (input, init) => recordedFetch(input, init, true);

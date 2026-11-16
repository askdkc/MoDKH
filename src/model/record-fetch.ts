let recordingProxy: string | undefined;

export function configureHttpModelRecording(proxyUrl: string | undefined): void {
  const proxy = URL.parse(proxyUrl ?? '');
  recordingProxy = proxy?.protocol === 'http:' && proxy.hostname === '127.0.0.1' &&
    !proxy.username && !proxy.password ? proxy.origin : undefined;
}

export const fetchModel: typeof fetch = (input, init) => {
  if (!recordingProxy) return fetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const method = init?.method ?? request?.method;
  const target = URL.parse(request?.url ?? String(input));
  if (method?.toUpperCase() !== 'POST' || target?.protocol !== 'http:' ||
      target.username || target.password || target.origin === recordingProxy) return fetch(input, init);

  // AgenticReplay restores this origin upstream. Keep the endpoint path outside the encoded segment.
  const destination = `${recordingProxy}/forward/${encodeURIComponent(target.origin)}${target.pathname}${target.search}`;
  return fetch(request ? new Request(destination, request) : destination, init);
};

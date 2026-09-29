// Types for proxy.conf.mjs, which `ng serve` loads as plain JavaScript, so its spec can import it.
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';

interface RelayProxy {
  web(req: IncomingMessage, res: ServerResponse, options: object): void;
  on(event: 'proxyReq', handler: (proxyReq: ClientRequest) => void): unknown;
  on(event: 'proxyRes', handler: (proxyRes: IncomingMessage) => void): unknown;
}

declare const proxyConfig: {
  '/jira-relay': {
    target: string;
    changeOrigin: boolean;
    rewrite(path: string): string;
    configure(proxy: RelayProxy): void;
  };
};

export default proxyConfig;

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import proxyConfig from './proxy.conf.mjs';

describe('dev-server relay to Jira', () => {
  it('calls Jira as a server-side client, so Jira Cloud accepts its writes', async () => {
    const handlers = new Map<string, (message: never) => void>();
    proxyConfig['/jira-relay'].configure({
      web: () => undefined,
      on: (event: string, handler: (message: never) => void) => handlers.set(event, handler),
    });

    let received: http.IncomingHttpHeaders = {};
    const jira = http.createServer((req, res) => {
      received = req.headers;
      res.end();
    });
    await new Promise<void>((resolve) => jira.listen(0, resolve));
    try {
      // What the browser sends the dev server for a worklog POST.
      const proxyReq = http.request({
        port: (jira.address() as AddressInfo).port,
        method: 'POST',
        path: '/rest/api/3/issue/GWP-1/worklog',
        headers: {
          Authorization: 'Basic ZGV2OnRva2Vu',
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
          Origin: 'http://localhost:4200',
          Referer: 'http://localhost:4200/',
          Cookie: 'session=localhost',
          'X-Jira-Host': 'https://example.atlassian.net',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'Sec-CH-UA': '"Chromium";v="141"',
          'Sec-CH-UA-Platform': '"Linux"',
        },
      });
      (handlers.get('proxyReq') as (proxyReq: http.ClientRequest) => void)(proxyReq);
      await new Promise<void>((resolve, reject) => {
        proxyReq.on('response', (response) => response.resume().on('end', resolve));
        proxyReq.on('error', reject);
        proxyReq.end('{}');
      });
    } finally {
      await new Promise((resolve) => jira.close(resolve));
    }

    expect(received['user-agent']).toBe('jira-timesheets-relay');
    expect(received['x-atlassian-token']).toBe('no-check');
    expect(received['authorization']).toBe('Basic ZGV2OnRva2Vu');
    expect(
      Object.keys(received).filter((header) =>
        /^(?:origin|referer|cookie|x-jira-host|sec-)/.test(header),
      ),
    ).toEqual([]);
  });
});

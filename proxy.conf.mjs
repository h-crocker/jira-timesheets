// Jira Cloud sends no CORS headers, so a page on localhost:4200 can't call it directly. `ng serve`
// relays /jira-relay/* to the site named in the X-Jira-Host header instead (see JIRA_RELAY_URL).
const ALLOWED_SITE =
  /^(?:https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/i;

export default {
  '/jira-relay': {
    // Replaced per request by the site in X-Jira-Host.
    target: 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/jira-relay/, ''),
    configure(proxy) {
      const forward = proxy.web;
      proxy.web = (req, res, options) => {
        const site = String(req.headers['x-jira-host'] ?? '');
        if (!ALLOWED_SITE.test(site)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              errorMessages: [
                `The dev-server relay only forwards to https://<site>.atlassian.net or a local mock, not "${site}"`,
              ],
              errors: {},
            }),
          );
          return;
        }
        forward(req, res, { ...options, target: site });
      };
      proxy.on('proxyReq', (proxyReq) => {
        // Jira shouldn't see the page's origin or localhost cookies, and it treats
        // browser-originated writes as possible XSRF unless they carry the no-check token.
        for (const header of ['origin', 'referer', 'cookie', 'x-jira-host']) {
          proxyReq.removeHeader(header);
        }
        proxyReq.setHeader('X-Atlassian-Token', 'no-check');
      });
      proxy.on('proxyRes', (proxyRes) => {
        delete proxyRes.headers['set-cookie'];
      });
    },
  },
};

// CommonJS, like the mocks themselves, so ts-node runs it without a build step.
const jira = require('./mock-jira-server') as typeof import('./mock-jira-server');
const github = require('./mock-github-server') as typeof import('./mock-github-server');

// Starts both mocks: Jira Cloud on PORT (3000) and GitHub on GITHUB_PORT (3001).
async function main(): Promise<void> {
  const [jiraServer, githubServer] = await Promise.all([jira.startServer(), github.startServer()]);
  const port = (server: typeof jiraServer) => {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : '?';
  };
  console.log(`Mock Jira server listening on http://localhost:${port(jiraServer)}`);
  console.log(`Mock GitHub server listening on http://localhost:${port(githubServer)}`);
}

void main();

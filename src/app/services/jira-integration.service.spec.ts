import { TestBed } from '@angular/core/testing';
import { JIRA_RELAY_URL, JiraIntegrationService } from './jira-integration.service';
import { SettingsService } from './settings.service';

describe('JiraIntegrationService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('routing', () => {
    let requests: Array<{ url: string; headers: Record<string, string> }>;
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      requests = [];
      spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        requests.push({
          url: String(input),
          headers: { ...(init?.headers as Record<string, string>) },
        });
        return new Response(
          JSON.stringify({ startAt: 0, maxResults: 50, total: 0, worklogs: [] }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      });
    });

    afterEach(() => spy.mockRestore());

    function useSite(site: string): JiraIntegrationService {
      TestBed.inject(SettingsService).setCredentials({
        email: 'me@example.com',
        apiToken: 'token',
        host: site,
      });
      return TestBed.inject(JiraIntegrationService);
    }

    it('goes through the relay, naming the Jira site in X-Jira-Host', async () => {
      TestBed.configureTestingModule({
        providers: [{ provide: JIRA_RELAY_URL, useValue: 'http://localhost:4200/jira-relay' }],
      });
      await useSite('https://example-site.atlassian.net/jira/your-work').fetchWorklogs('GWP-1');

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.url.startsWith('http://localhost:4200/jira-relay/rest/api/3/')).toBe(true);
        expect(request.headers['X-Jira-Host']).toBe('https://example-site.atlassian.net');
        expect(request.headers['Authorization']).toMatch(/^Basic /);
      }
    });

    it('calls the site directly without a relay, adding a missing https://', async () => {
      await useSite('example-site.atlassian.net').fetchWorklogs('GWP-1');

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.url.startsWith('https://example-site.atlassian.net/rest/api/3/')).toBe(true);
        expect(request.headers['X-Jira-Host']).toBeUndefined();
      }
    });
  });
});

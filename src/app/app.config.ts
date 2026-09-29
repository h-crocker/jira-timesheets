import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { JIRA_RELAY_URL } from './services/jira-integration.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Jira Cloud rejects cross-origin browser calls, so go through the relay `ng serve` provides.
    { provide: JIRA_RELAY_URL, useFactory: () => `${window.location.origin}/jira-relay` },
  ],
};

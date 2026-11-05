import type { JiraRestClient } from './jira-rest-client';

/** The part of the Jira client that planning, applying and verifying need; tests can fake it. */
export type CorrectionsClient = Pick<
  JiraRestClient,
  | 'redact'
  | 'myself'
  | 'ownWorklogs'
  | 'getWorklog'
  | 'updateWorklog'
  | 'deleteWorklog'
  | 'addWorklog'
  | 'myPermissions'
  | 'editableFieldCount'
>;

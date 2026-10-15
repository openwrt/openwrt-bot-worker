export interface Env {
  WEBHOOK_SECRET?: string;
  APP_ID?: string | number;
  PRIVATE_KEY?: string;
  DEPLOY_HASH?: string;
  DEPLOY_DATE?: string;
  SUBREQUEST_BUDGET_LIMIT?: string;
  SUBREQUEST_RESERVE_HEADROOM?: string;
  GRAPHQL_CHUNK_SIZE?: string;
  [key: string]: unknown;
}

export interface SubrequestBudget {
  limit: number;
  reserve: number;
  used: number;
}

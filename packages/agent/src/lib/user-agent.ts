import { SDK_METADATA } from '@openrouter/sdk/lib/config';

import { PACKAGE_VERSION } from '../mcp/version.js';

/** Keeps the base Speakeasy string byte-identical and appends one token for openrouter-web analytics. */
export const AGENT_USER_AGENT = `${SDK_METADATA.userAgent} @openrouter/agent/${PACKAGE_VERSION}`;

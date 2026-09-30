# Connections

Open **Connections** to see which app integrations are available to Work. A listed service is not automatically connected: it needs the service's own credentials, permissions, and account consent.

## Pipedream Connect

1. Create a Pipedream Connect project outside Seek.
2. On the local Windows PC, open **Connections** and enter its client ID, client secret, project ID, and environment.
3. Search the app catalog and use the Connect Link for each app you want to authorize.
4. Return to **Connections** to see linked accounts and ask Work to read from an authorized app.

The Pipedream client secret is protected with Windows DPAPI for the current user. Work discovers the linked app's tools when needed, and `apps_read` calls bounded read actions through Pipedream's remote MCP service. It rejects write actions. The app does not load every available tool into every model prompt. Changes made through the browser stay on its separate approval path; connecting an app does not authorize sending or changing things on your behalf.

## Discord and Google

If the harness has a Discord bot token, Work can read the servers, channels, and messages that bot is allowed to access. Message bodies also depend on Discord's Message Content intent. If the bot is not configured, the connection is unavailable.

Gmail and Calendar MCP entries may appear as staged or unavailable until Google OAuth credentials and consent are supplied. Work does not invent an account or connect it automatically.

For a website without a suitable connected tool, ask Work to use its [shared browser](https://github.com/thejoelrobinson/seek-stack/wiki/Browser-and-Receipts) and sign in yourself when prompted. Optional connected services exchange data with their providers; the local model still runs on the host PC.

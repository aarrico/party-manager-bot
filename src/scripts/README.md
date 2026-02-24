# Scripts

This directory contains standalone scripts for development and testing purposes.

## delete-commands.ts

Delete registered bot commands from Discord.

## list-sessions.ts

List all sessions in the database with their details.

### Usage

```bash
npm run list-sessions
```

### Output

Displays a formatted list of all sessions including:

- Session ID
- Session name
- Status (with colored emoji indicator)
- Date and timezone
- Campaign name
- Party size
- Party members with their roles

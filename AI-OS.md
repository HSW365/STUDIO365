# STUDIO365 AI Business OS

STUDIO365 now includes an AI Business OS dashboard at /ai.html.

## Included
- AI command center and orchestration endpoint
- CRM/lead pipeline UI
- AI estimate generator endpoint
- appointment pipeline
- automation center
- agent control center
- analytics dashboard
- 3-day trial / $15 monthly billing configuration
- Cash App identity: $hsw365
- secure server-side environment variables for Cash App and AI providers

## Deployment
The existing music studio remains intact. Deploy the new Node service with render-ai.yaml or run:
npm --prefix server install
npm --prefix server start

Never commit CASH_APP_API_KEY or AI_API_KEY. Put secrets in Render environment variables.

## Billing
The application is configured for a 3-day trial and $15/month entitlement. Live Cash App Pay processing requires merchant/client credentials and the appropriate Cash App Pay merchant access.
# LeadFlow

## Technology Stack

- **Language**: typescript
- **Framework**: express
- **Database**: postgresql

## Getting Started

### Prerequisites

- Node.js 18+ (LTS recommended)
- npm, yarn, or pnpm

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start database (Docker)
docker-compose up -d

# Run migrations
npm run migrate

# Start development server
npm run dev
```

The server will be running at http://localhost:3000

## Available Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run test` | Run tests |
| `npm run migrate` | Run database migrations |
| `npm run lint` | Lint code |

## Project Structure

See the generated folder structure for detailed organization.

## Environment Variables

Copy `.env.example` to `.env` and configure:

- Database connection settings
- JWT secrets
- API keys
- Other configuration

## License

MIT

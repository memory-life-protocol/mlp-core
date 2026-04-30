/**
 * Create Workspace Script
 *
 * One-time script to create a workspace in MLP.
 * Run this before encoding any knowledge.
 *
 * This script is a reference implementation.
 * It is safe to be in the open source repo.
 *
 * NEVER commit the output of this script.
 * Your workspace ID and API key are private credentials.
 * Store them in a password manager or secrets vault.
 * The API key is shown only once — if lost, regenerate it.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=your_key \
 *   FALKORDB_HOST=your_host \
 *   FALKORDB_PORT=your_port \
 *   MLP_ENV=production \
 *   npm run create-workspace -- --name "Your Org Name" --owner "founder"
 *
 * Output:
 *   Workspace ID and API key printed to console only.
 *   Never written to any file.
 *   Never sent anywhere.
 *   Save these immediately after running.
 *
 * Authentication format for tool connections:
 *   Authorization: Bearer workspaceId:apiKey
 */

import 'dotenv/config'
import { randomUUID, createHash } from 'node:crypto'

function parseArgs(argv: string[]): { name: string; owner: string } {
  const args = argv.slice(2)
  let name = ''
  let owner = ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i]
    if (args[i] === '--owner' && args[i + 1]) owner = args[++i]
  }

  if (!name) {
    console.error('Error: --name is required')
    console.error('Usage: npm run create-workspace -- --name "Your Org" --owner "founder"')
    process.exit(1)
  }

  if (!owner) {
    console.error('Error: --owner is required')
    console.error('Usage: npm run create-workspace -- --name "Your Org" --owner "founder"')
    process.exit(1)
  }

  return { name, owner }
}

async function main(): Promise<void> {
  const { name, owner } = parseArgs(process.argv)

  const workspaceId = randomUUID()
  const apiKey = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
  const now = new Date().toISOString()

  const workspace = {
    id: workspaceId,
    name,
    created_at: now,
    owner_id: owner,
    api_key_hash: apiKeyHash
  }

  // Connect to storage and create workspace
  const IS_PRODUCTION = process.env.MLP_ENV === 'production'

  if (IS_PRODUCTION) {
    const falkordbPath = '../dist/connectors/falkordb/adapter.js'
    const { FalkorDBAdapter } = await import(falkordbPath)

    const storage = new FalkorDBAdapter({
      host: process.env.FALKORDB_HOST ?? 'localhost',
      port: parseInt(process.env.FALKORDB_PORT ?? '6379')
    })

    await storage.connect()
    const result = await storage.createWorkspace(workspace)
    await storage.disconnect()

    if (!result.success) {
      console.error('Failed to create workspace:', result.error)
      process.exit(1)
    }
  } else {
    console.error('[dev mode] Workspace not persisted — MLP_ENV is not production')
  }

  // Print credentials — shown once, never stored
  console.log('\n=== MLP Workspace Created ===\n')
  console.log(`Workspace ID : ${workspaceId}`)
  console.log(`Name         : ${name}`)
  console.log(`Owner        : ${owner}`)
  console.log(`Created      : ${now}`)
  console.log(`\nAPI Key      : ${apiKey}`)
  console.log('\n=== Save these credentials now ===')
  console.log('The API key is shown only once.')
  console.log('\nAuthorization header for tool connections:')
  console.log(`  Authorization: Bearer ${workspaceId}:${apiKey}`)
  console.log()
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

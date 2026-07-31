# Optional Godot Information API

This document describes an optional external documentation service. Gofer does not call this service; its implemented
API is the local `POST /query` endpoint on port 3000.

## Configuration

Keep the service URL and bearer token outside the repository:

```bash
export GODOT_API_BASE_URL='http://localhost:3001/workspace/godot-4-dot-7'
export GODOT_API_TOKEN='<local-token>'
```

Never commit a real token. If a token has been committed previously, revoke it before replacing it.

## Request helper

```ts
const baseUrl = process.env.GODOT_API_BASE_URL
const token = process.env.GODOT_API_TOKEN

if (!baseUrl || !token) throw new Error('GODOT_API_BASE_URL and GODOT_API_TOKEN are required')

export async function godotApi(path: string): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`
        }
    })
    if (!response.ok) throw new Error(`Godot API request failed: ${response.status} ${await response.text()}`)
    return response.json()
}
```

Endpoint paths and response schemas must be obtained from the service itself. The repository does not contain a
verified contract for that external API.

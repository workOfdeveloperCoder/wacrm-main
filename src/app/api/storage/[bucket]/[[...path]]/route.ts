import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { sessionUser } from '@/lib/db/auth'
import { buildClient } from '@/lib/db/server'
import { SESSION_COOKIE } from '@/lib/db/session'

const ROOT = path.join(process.cwd(), 'data', 'storage')

async function requireUser() {
  const store = await cookies()
  return sessionUser(store.get(SESSION_COOKIE)?.value)
}

function safePath(bucket: string, parts: string[]) {
  const target = path.resolve(ROOT, bucket, ...parts)
  const root = path.resolve(ROOT, bucket)
  if (!target.startsWith(root)) return null
  return target
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bucket: string; path?: string[] }> },
) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { bucket, path: parts = [] } = await params
  const target = safePath(bucket, parts)
  if (!target) return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  try {
    await stat(target)
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream
  return new NextResponse(stream)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bucket: string; path?: string[] }> },
) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 })
  const { bucket, path: parts = [] } = await params
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ data: null, error: { message: 'File is required' } }, { status: 400 })
  }
  const client = buildClient(user.sub, false)
  return NextResponse.json(
    await client.storage.from(bucket).upload(parts.join('/'), file, {
      upsert: form.get('upsert') === '1',
    }),
  )
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bucket: string }> },
) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 })
  const { bucket } = await params
  const { paths } = (await request.json()) as { paths?: string[] }
  const client = buildClient(user.sub, false)
  return NextResponse.json(await client.storage.from(bucket).remove(paths ?? []))
}

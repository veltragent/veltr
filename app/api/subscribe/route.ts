import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { readState, writeState, type Subscription } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { destination?: string; address?: string | null; minDeltaPct?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const destination = body.destination?.trim();
  if (!destination || !/^-?\d+$/.test(destination)) {
    return NextResponse.json(
      { error: "destination must be a numeric Telegram chat id." },
      { status: 400 }
    );
  }

  const address = body.address?.trim() || null;
  if (address && !isAddress(address)) {
    return NextResponse.json({ error: "address is not a valid EVM address." }, { status: 400 });
  }

  const minDeltaPct = Number.isFinite(body.minDeltaPct) ? Math.abs(Number(body.minDeltaPct)) : 0;

  const state = await readState();

  const existing = state.subscriptions.find(
    (s) => s.destination === destination && s.address === address
  );
  if (existing) {
    return NextResponse.json({ subscription: existing, created: false });
  }

  const subscription: Subscription = {
    id: randomUUID(),
    address,
    channel: "telegram",
    destination,
    minDeltaPct,
    createdAt: new Date().toISOString(),
  };

  await writeState({ ...state, subscriptions: [...state.subscriptions, subscription] });

  return NextResponse.json({
    subscription,
    created: true,
    delivery: process.env.VELTR_TELEGRAM_BOT_TOKEN
      ? "active"
      : "queued — VELTR_TELEGRAM_BOT_TOKEN is not configured yet",
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const state = await readState();
  const remaining = state.subscriptions.filter((s) => s.id !== id);
  if (remaining.length === state.subscriptions.length) {
    return NextResponse.json({ error: "No such subscription." }, { status: 404 });
  }

  await writeState({ ...state, subscriptions: remaining });
  return NextResponse.json({ removed: id });
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { team_name, match_date } = body;

  const id = uuidv4();

  const { error } = await supabaseAdmin.from("sessions").insert({
    id,
    status: "created",
    team_name: team_name || null,
    match_date: match_date || null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id });
}

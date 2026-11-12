import { useState } from 'react';
import { useParams } from 'react-router';
import { SessionCodeSchema, type Membership } from '@yumanimous/shared';
import { loadIdentity } from '../lib/identity';
import { JoinScreen } from '../session/JoinScreen';
import { SessionRoom } from '../session/SessionRoom';
import { NotFound } from './NotFound';

/**
 * `/s/:code`, the link people tap in the group chat. With a saved identity for this
 * code we go straight back in (refresh, reopened tab); otherwise ask for a name.
 */
export function SessionPage() {
  const parsed = SessionCodeSchema.safeParse(useParams().code);
  if (!parsed.success) return <NotFound />;
  // Keyed by code so moving between sessions resets all state.
  return <SessionGate key={parsed.data} code={parsed.data} />;
}

function SessionGate({ code }: { code: string }) {
  const [membership, setMembership] = useState<Membership | null>(() => loadIdentity(code));

  if (!membership) return <JoinScreen code={code} onJoined={setMembership} />;
  return <SessionRoom membership={membership} onLostIdentity={() => setMembership(null)} />;
}

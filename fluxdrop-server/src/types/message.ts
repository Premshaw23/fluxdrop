// fluxdrop-server/src/types/messages.ts
import { z } from 'zod';

// Message schemas
const CreateSessionSchema = z.object({
  type: z.literal('create-session'),
  senderName: z.string().optional()
});

const JoinSessionSchema = z.object({
  type: z.literal('join-session'),
  code: z.string().length(6)
});

const OfferSchema = z.object({
  type: z.literal('offer'),
  sdp: z.string()
});

const AnswerSchema = z.object({
  type: z.literal('answer'),
  sdp: z.string()
});


const IceCandidateSchema = z.object({
  type: z.literal('ice-candidate'),
  candidate: z.object({
    candidate: z.string(),
    sdpMLineIndex: z.number().nullable(),
    sdpMid: z.string().nullable()
  })
});

const PublicKeySchema = z.object({
  type: z.literal('public-key'),
  publicKey: z.string()
});


const DiscoveryAnnounceSchema = z.object({
  type: z.literal("discovery:announce"),
  device: z.object({
    id: z.string().optional(),
    name: z.string(),
    type: z.string(),
    model: z.string().optional(),
  }),
});

const DiscoveryListSchema = z.object({
  type: z.literal("discovery:list"),
});

const DiscoveryInviteSchema = z.object({
  type: z.literal("discovery:invite"),
  targetId: z.string(),
  code: z.string(),
  senderName: z.string().optional(),
});

const SessionCancelSchema = z.object({
  type: z.literal("session-cancel"),
});

export const SignalingMessageSchema = z.discriminatedUnion("type", [
  CreateSessionSchema,
  JoinSessionSchema,
  OfferSchema,
  AnswerSchema,
  IceCandidateSchema,
  PublicKeySchema,
  DiscoveryAnnounceSchema,
  DiscoveryListSchema,
  DiscoveryInviteSchema,
  SessionCancelSchema,
]);

export type SignalingMessage = z.infer<typeof SignalingMessageSchema>;

export function validateMessage(message: unknown) {
  return SignalingMessageSchema.safeParse(message);
}

// Server response types
export type ServerMessage = 
  | { type: 'session-created'; code: string; expiresIn: number }
  | { type: 'session-joined'; code: string; senderName?: string }
  | { type: 'peer-joined' }
  | { type: 'peer-disconnected' }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'error'; error: string };
// fluxdrop-server/src/types/messages.ts
import { z } from 'zod';
// Message schemas
const CreateSessionSchema = z.object({
    type: z.literal('create-session')
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
export const SignalingMessageSchema = z.discriminatedUnion('type', [
    CreateSessionSchema,
    JoinSessionSchema,
    OfferSchema,
    AnswerSchema,
    IceCandidateSchema,
    PublicKeySchema
]);
export function validateMessage(message) {
    return SignalingMessageSchema.safeParse(message);
}
//# sourceMappingURL=message.js.map
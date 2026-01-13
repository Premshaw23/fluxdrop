import { z } from 'zod';
export declare const SignalingMessageSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"create-session">;
}, "strip", z.ZodTypeAny, {
    type: "create-session";
}, {
    type: "create-session";
}>, z.ZodObject<{
    type: z.ZodLiteral<"join-session">;
    code: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "join-session";
    code: string;
}, {
    type: "join-session";
    code: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"offer">;
    sdp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "offer";
    sdp: string;
}, {
    type: "offer";
    sdp: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"answer">;
    sdp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "answer";
    sdp: string;
}, {
    type: "answer";
    sdp: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"ice-candidate">;
    candidate: z.ZodObject<{
        candidate: z.ZodString;
        sdpMLineIndex: z.ZodNullable<z.ZodNumber>;
        sdpMid: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    }, {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "ice-candidate";
    candidate: {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    };
}, {
    type: "ice-candidate";
    candidate: {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"public-key">;
    publicKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "public-key";
    publicKey: string;
}, {
    type: "public-key";
    publicKey: string;
}>]>;
export type SignalingMessage = z.infer<typeof SignalingMessageSchema>;
export declare function validateMessage(message: unknown): z.SafeParseReturnType<{
    type: "create-session";
} | {
    type: "join-session";
    code: string;
} | {
    type: "offer";
    sdp: string;
} | {
    type: "answer";
    sdp: string;
} | {
    type: "ice-candidate";
    candidate: {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    };
} | {
    type: "public-key";
    publicKey: string;
}, {
    type: "create-session";
} | {
    type: "join-session";
    code: string;
} | {
    type: "offer";
    sdp: string;
} | {
    type: "answer";
    sdp: string;
} | {
    type: "ice-candidate";
    candidate: {
        candidate: string;
        sdpMLineIndex: number | null;
        sdpMid: string | null;
    };
} | {
    type: "public-key";
    publicKey: string;
}>;
export type ServerMessage = {
    type: 'session-created';
    code: string;
    expiresIn: number;
} | {
    type: 'session-joined';
    code: string;
} | {
    type: 'peer-joined';
} | {
    type: 'peer-disconnected';
} | {
    type: 'offer';
    sdp: string;
} | {
    type: 'answer';
    sdp: string;
} | {
    type: 'ice-candidate';
    candidate: RTCIceCandidateInit;
} | {
    type: 'error';
    error: string;
};
//# sourceMappingURL=message.d.ts.map
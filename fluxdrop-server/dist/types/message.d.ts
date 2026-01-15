import { z } from 'zod';
export declare const SignalingMessageSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"create-session">;
    senderName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "create-session";
    senderName?: string | undefined;
}, {
    type: "create-session";
    senderName?: string | undefined;
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
}>, z.ZodObject<{
    type: z.ZodLiteral<"discovery:announce">;
    device: z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        type: z.ZodString;
        model: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    }, {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "discovery:announce";
    device: {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    };
}, {
    type: "discovery:announce";
    device: {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"discovery:list">;
}, "strip", z.ZodTypeAny, {
    type: "discovery:list";
}, {
    type: "discovery:list";
}>, z.ZodObject<{
    type: z.ZodLiteral<"discovery:invite">;
    targetId: z.ZodString;
    code: z.ZodString;
    senderName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "discovery:invite";
    code: string;
    targetId: string;
    senderName?: string | undefined;
}, {
    type: "discovery:invite";
    code: string;
    targetId: string;
    senderName?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"session-cancel">;
}, "strip", z.ZodTypeAny, {
    type: "session-cancel";
}, {
    type: "session-cancel";
}>]>;
export type SignalingMessage = z.infer<typeof SignalingMessageSchema>;
export declare function validateMessage(message: unknown): z.SafeParseReturnType<{
    type: "create-session";
    senderName?: string | undefined;
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
} | {
    type: "discovery:announce";
    device: {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    };
} | {
    type: "discovery:list";
} | {
    type: "discovery:invite";
    code: string;
    targetId: string;
    senderName?: string | undefined;
} | {
    type: "session-cancel";
}, {
    type: "create-session";
    senderName?: string | undefined;
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
} | {
    type: "discovery:announce";
    device: {
        type: string;
        name: string;
        id?: string | undefined;
        model?: string | undefined;
    };
} | {
    type: "discovery:list";
} | {
    type: "discovery:invite";
    code: string;
    targetId: string;
    senderName?: string | undefined;
} | {
    type: "session-cancel";
}>;
export type ServerMessage = {
    type: 'session-created';
    code: string;
    expiresIn: number;
} | {
    type: 'session-joined';
    code: string;
    senderName?: string;
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
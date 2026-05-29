import { PrismaClient, DisputeStatus } from "@prisma/client";
import { AppError, ErrorCode } from "../errors/errorCodes";
import { getMediatorAllowlist } from "../lib/accessControl";

/** Terminal dispute statuses — disputes in these states are considered complete. */
export const COMPLETED_DISPUTE_STATUSES: DisputeStatus[] = [
  DisputeStatus.RESOLVED,
  DisputeStatus.CLOSED,
];

export interface DisputeCleanupResult {
  purgedCount: number;
  tradeIds: string[];
}

export interface DisputeResponse {
  id: number;
  tradeId: string;
  initiator: string;
  reason: string;
  status: DisputeStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  trade: {
    buyerAddress: string;
    sellerAddress: string;
    amountUsdc: string;
  };
}

export interface DisputeListResponse {
  items: DisputeResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Valid forward-only status transition map for disputes. */
const VALID_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  [DisputeStatus.OPEN]: [DisputeStatus.UNDER_REVIEW, DisputeStatus.CLOSED],
  [DisputeStatus.UNDER_REVIEW]: [DisputeStatus.RESOLVED, DisputeStatus.CLOSED],
  [DisputeStatus.RESOLVED]: [],
  [DisputeStatus.CLOSED]: [],
};

export class DisputeService {
  constructor(private prisma: PrismaClient) {}

  async listMediatorDisputes(
    mediatorAddress: string,
    params: { status?: DisputeStatus; page?: number; limit?: number } = {}
  ): Promise<DisputeListResponse> {
    const { status, page = 1, limit = 10 } = params;
    const offset = (page - 1) * limit;

    if (!getMediatorAllowlist().has(mediatorAddress)) {
      throw new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403);
    }

    const where = status
      ? { status }
      : { status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] as DisputeStatus[] } };

    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        include: {
          trade: {
            select: { buyerAddress: true, sellerAddress: true, amountUsdc: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return {
      items: disputes.map(d => ({
        id: d.id,
        tradeId: d.tradeId,
        initiator: d.initiator,
        reason: d.reason,
        status: d.status,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        resolvedAt: d.resolvedAt?.toISOString() ?? null,
        trade: d.trade,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getDisputeByTradeId(tradeId: string): Promise<DisputeResponse | null> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { tradeId },
      include: {
        trade: { select: { buyerAddress: true, sellerAddress: true, amountUsdc: true } },
      },
    });

    if (!dispute) return null;

    return {
      id: dispute.id,
      tradeId: dispute.tradeId,
      initiator: dispute.initiator,
      reason: dispute.reason,
      status: dispute.status,
      createdAt: dispute.createdAt.toISOString(),
      updatedAt: dispute.updatedAt.toISOString(),
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      trade: dispute.trade,
    };
  }

  /**
   * Purge transient/sensitive data fields from disputes that have reached a
   * terminal status (RESOLVED or CLOSED).  The core record is retained for
   * audit purposes; only the free-text `reason` field is cleared so that PII
   * is not stored indefinitely after a case concludes.
   *
   * Only a mediator (address listed in ADMIN_STELLAR_PUBKEYS) may trigger this
   * operation.  Returns the number of records updated and the affected tradeIds.
   */
  async purgeCompletedDisputeData(
    mediatorAddress: string,
    olderThanDays = 90
  ): Promise<DisputeCleanupResult> {
    if (!getMediatorAllowlist().has(mediatorAddress)) {
      throw new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403);
    }

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const completed = await this.prisma.dispute.findMany({
      where: {
        status: { in: COMPLETED_DISPUTE_STATUSES },
        resolvedAt: { lte: cutoff },
        reason: { not: "" },
      },
      select: { id: true, tradeId: true },
    });

    if (completed.length === 0) {
      return { purgedCount: 0, tradeIds: [] };
    }

    const ids = completed.map((d: { id: number; tradeId: string }) => d.id);

    await this.prisma.dispute.updateMany({
      where: { id: { in: ids } },
      data: { reason: "" },
    });

    return {
      purgedCount: completed.length,
      tradeIds: completed.map((d: { id: number; tradeId: string }) => d.tradeId),
    };
  }

  /**
   * Transition a dispute to a new status.
   * Only valid forward transitions are permitted; backwards or sideways moves throw
   * DISPUTE_STATUS_TRANSITION_INVALID.
   */
  async transitionDisputeStatus(
    tradeId: string,
    mediatorAddress: string,
    newStatus: DisputeStatus
  ): Promise<DisputeResponse> {
    if (!getMediatorAllowlist().has(mediatorAddress)) {
      throw new AppError(ErrorCode.AUTH_ERROR, "Unauthorized: Not a mediator", 403);
    }

    const dispute = await this.prisma.dispute.findFirst({
      where: { tradeId },
      include: {
        trade: { select: { buyerAddress: true, sellerAddress: true, amountUsdc: true } },
      },
    });

    if (!dispute) {
      throw new AppError(ErrorCode.DISPUTE_NOT_FOUND, `No dispute found for trade: ${tradeId}`, 404);
    }

    const allowedNext = VALID_TRANSITIONS[dispute.status];
    if (!allowedNext.includes(newStatus)) {
      throw new AppError(
        ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
        `Cannot transition dispute from ${dispute.status} to ${newStatus}`,
        422,
        {
          currentStatus: dispute.status,
          requestedStatus: newStatus,
          allowedTransitions: allowedNext,
        },
      );
    }

    const resolvedAt =
      newStatus === DisputeStatus.RESOLVED || newStatus === DisputeStatus.CLOSED
        ? new Date()
        : undefined;

    const updated = await this.prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        status: newStatus,
        ...(resolvedAt !== undefined && { resolvedAt }),
      },
      include: {
        trade: { select: { buyerAddress: true, sellerAddress: true, amountUsdc: true } },
      },
    });

    return {
      id: updated.id,
      tradeId: updated.tradeId,
      initiator: updated.initiator,
      reason: updated.reason,
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      resolvedAt: updated.resolvedAt?.toISOString() ?? null,
      trade: updated.trade,
    };
  }
}

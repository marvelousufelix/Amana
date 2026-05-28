import { PrismaClient, DisputeStatus } from "@prisma/client";
import { AppError, ErrorCode } from "../errors/errorCodes";

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

    const mediatorAddresses = (process.env.ADMIN_STELLAR_PUBKEYS ?? "")
      .split(",")
      .map(addr => addr.trim());
    if (!mediatorAddresses.includes(mediatorAddress)) {
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
   * Transition a dispute to a new status.
   * Only valid forward transitions are permitted; backwards or sideways moves throw
   * DISPUTE_STATUS_TRANSITION_INVALID.
   */
  async transitionDisputeStatus(
    tradeId: string,
    mediatorAddress: string,
    newStatus: DisputeStatus
  ): Promise<DisputeResponse> {
    const mediatorAddresses = (process.env.ADMIN_STELLAR_PUBKEYS ?? "")
      .split(",")
      .map(addr => addr.trim());
    if (!mediatorAddresses.includes(mediatorAddress)) {
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

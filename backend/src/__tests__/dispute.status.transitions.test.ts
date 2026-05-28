import { PrismaClient, DisputeStatus } from "@prisma/client";
import { DisputeService } from "../services/dispute.service";
import { AppError, ErrorCode } from "../errors/errorCodes";

const MEDIATOR = "GA_MEDIATOR_VALID";

function createMockPrisma() {
  return {
    dispute: {
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  } as unknown as PrismaClient;
}

function makeDispute(status: DisputeStatus, id = 1, tradeId = "T-001") {
  const now = new Date();
  return {
    id,
    tradeId,
    initiator: "GA_BUYER",
    reason: "Item not received",
    status,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    trade: { buyerAddress: "GA_BUYER", sellerAddress: "GA_SELLER", amountUsdc: "100" },
  };
}

describe("DisputeService – status transitions", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: DisputeService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new DisputeService(prisma as any);
    process.env.ADMIN_STELLAR_PUBKEYS = MEDIATOR;
  });

  afterEach(() => {
    delete process.env.ADMIN_STELLAR_PUBKEYS;
    jest.clearAllMocks();
  });

  // ── Valid forward transitions ─────────────────────────────────────────────

  it("OPEN → UNDER_REVIEW: succeeds and persists new status", async () => {
    const dispute = makeDispute(DisputeStatus.OPEN);
    const updated = { ...dispute, status: DisputeStatus.UNDER_REVIEW };

    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(dispute);
    (prisma.dispute.update as jest.Mock).mockResolvedValue(updated);

    const result = await service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.UNDER_REVIEW);

    expect(prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DisputeStatus.UNDER_REVIEW }),
      }),
    );
    expect(result.status).toBe(DisputeStatus.UNDER_REVIEW);
  });

  it("OPEN → CLOSED: succeeds and sets resolvedAt", async () => {
    const dispute = makeDispute(DisputeStatus.OPEN);
    const now = new Date();
    const updated = { ...dispute, status: DisputeStatus.CLOSED, resolvedAt: now };

    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(dispute);
    (prisma.dispute.update as jest.Mock).mockResolvedValue(updated);

    const result = await service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.CLOSED);

    expect(prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolvedAt: expect.any(Date) }),
      }),
    );
    expect(result.status).toBe(DisputeStatus.CLOSED);
    expect(result.resolvedAt).toBeDefined();
  });

  it("UNDER_REVIEW → RESOLVED: succeeds and sets resolvedAt", async () => {
    const dispute = makeDispute(DisputeStatus.UNDER_REVIEW);
    const now = new Date();
    const updated = { ...dispute, status: DisputeStatus.RESOLVED, resolvedAt: now };

    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(dispute);
    (prisma.dispute.update as jest.Mock).mockResolvedValue(updated);

    const result = await service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.RESOLVED);

    expect(result.status).toBe(DisputeStatus.RESOLVED);
    expect(result.resolvedAt).toBeDefined();
  });

  it("UNDER_REVIEW → CLOSED: succeeds and sets resolvedAt", async () => {
    const dispute = makeDispute(DisputeStatus.UNDER_REVIEW);
    const now = new Date();
    const updated = { ...dispute, status: DisputeStatus.CLOSED, resolvedAt: now };

    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(dispute);
    (prisma.dispute.update as jest.Mock).mockResolvedValue(updated);

    const result = await service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.CLOSED);

    expect(result.status).toBe(DisputeStatus.CLOSED);
    expect(result.resolvedAt).toBeDefined();
  });

  // ── Invalid / blocked transitions ────────────────────────────────────────

  it("OPEN → RESOLVED: throws DISPUTE_STATUS_TRANSITION_INVALID (skip UNDER_REVIEW)", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(makeDispute(DisputeStatus.OPEN));

    await expect(
      service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.RESOLVED),
    ).rejects.toMatchObject({
      code: ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
    });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it("RESOLVED → any: throws DISPUTE_STATUS_TRANSITION_INVALID (terminal state)", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(makeDispute(DisputeStatus.RESOLVED));

    for (const next of [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW, DisputeStatus.CLOSED]) {
      await expect(
        service.transitionDisputeStatus("T-001", MEDIATOR, next),
      ).rejects.toMatchObject({
        code: ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
      });
    }
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it("CLOSED → any: throws DISPUTE_STATUS_TRANSITION_INVALID (terminal state)", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(makeDispute(DisputeStatus.CLOSED));

    for (const next of [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW, DisputeStatus.RESOLVED]) {
      await expect(
        service.transitionDisputeStatus("T-001", MEDIATOR, next),
      ).rejects.toMatchObject({
        code: ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
      });
    }
  });

  it("UNDER_REVIEW → OPEN: throws DISPUTE_STATUS_TRANSITION_INVALID (backwards move)", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(makeDispute(DisputeStatus.UNDER_REVIEW));

    await expect(
      service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.OPEN),
    ).rejects.toMatchObject({
      code: ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID,
    });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it("invalid transition error includes currentStatus, requestedStatus, and allowedTransitions", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(makeDispute(DisputeStatus.OPEN));

    let caught: AppError | undefined;
    try {
      await service.transitionDisputeStatus("T-001", MEDIATOR, DisputeStatus.RESOLVED);
    } catch (e) {
      caught = e as AppError;
    }

    expect(caught).toBeDefined();
    expect(caught!.code).toBe(ErrorCode.DISPUTE_STATUS_TRANSITION_INVALID);
    expect(caught!.details).toMatchObject({
      currentStatus: DisputeStatus.OPEN,
      requestedStatus: DisputeStatus.RESOLVED,
      allowedTransitions: expect.arrayContaining([DisputeStatus.UNDER_REVIEW, DisputeStatus.CLOSED]),
    });
  });

  // ── Authorization ─────────────────────────────────────────────────────────

  it("throws AUTH_ERROR if caller is not a mediator", async () => {
    await expect(
      service.transitionDisputeStatus("T-001", "GA_NOT_MEDIATOR", DisputeStatus.UNDER_REVIEW),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_ERROR });
    expect(prisma.dispute.findFirst).not.toHaveBeenCalled();
  });

  it("throws DISPUTE_NOT_FOUND if no dispute exists for the trade", async () => {
    (prisma.dispute.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.transitionDisputeStatus("T-UNKNOWN", MEDIATOR, DisputeStatus.UNDER_REVIEW),
    ).rejects.toMatchObject({ code: ErrorCode.DISPUTE_NOT_FOUND });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  // ── listMediatorDisputes ──────────────────────────────────────────────────

  it("listMediatorDisputes returns only OPEN and UNDER_REVIEW disputes by default", async () => {
    const openDispute = makeDispute(DisputeStatus.OPEN, 1, "T-A");
    const reviewDispute = makeDispute(DisputeStatus.UNDER_REVIEW, 2, "T-B");

    (prisma.dispute.findMany as jest.Mock).mockResolvedValue([openDispute, reviewDispute]);
    (prisma.dispute.count as jest.Mock).mockResolvedValue(2);

    const result = await service.listMediatorDisputes(MEDIATOR);

    expect(prisma.dispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
        },
      }),
    );
    expect(result.items).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
  });

  it("listMediatorDisputes filters by specific status when provided", async () => {
    (prisma.dispute.findMany as jest.Mock).mockResolvedValue([makeDispute(DisputeStatus.RESOLVED, 3, "T-C")]);
    (prisma.dispute.count as jest.Mock).mockResolvedValue(1);

    const result = await service.listMediatorDisputes(MEDIATOR, { status: DisputeStatus.RESOLVED });

    expect(prisma.dispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: DisputeStatus.RESOLVED } }),
    );
    expect(result.items[0].status).toBe(DisputeStatus.RESOLVED);
  });

  it("listMediatorDisputes throws AUTH_ERROR for non-mediator callers", async () => {
    await expect(
      service.listMediatorDisputes("GA_ATTACKER"),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_ERROR });
    expect(prisma.dispute.findMany).not.toHaveBeenCalled();
  });

  it("listMediatorDisputes paginates correctly", async () => {
    (prisma.dispute.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.dispute.count as jest.Mock).mockResolvedValue(50);

    const result = await service.listMediatorDisputes(MEDIATOR, { page: 3, limit: 10 });

    expect(prisma.dispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
    expect(result.pagination).toMatchObject({
      page: 3,
      limit: 10,
      total: 50,
      totalPages: 5,
    });
  });
});

import { zodToJsonSchema } from "zod-to-json-schema";
import {
  PIDecisionSchema,
  PIImplementationTaskSchema,
  PIApprovalRecordSchema,
  PIInvestigationRequestSchema,
  PIInvestigationResultSchema,
} from "./pi-clarification.js";
export const PIExternalSchemas = {
  ClarificationDecision: zodToJsonSchema(
    PIDecisionSchema,
    "ClarificationDecision",
  ),
  ImplementationTask: zodToJsonSchema(
    PIImplementationTaskSchema,
    "ImplementationTask",
  ),
  ApprovalRecord: zodToJsonSchema(PIApprovalRecordSchema, "ApprovalRecord"),
  InvestigationRequest: zodToJsonSchema(
    PIInvestigationRequestSchema,
    "InvestigationRequest",
  ),
  InvestigationResult: zodToJsonSchema(
    PIInvestigationResultSchema,
    "InvestigationResult",
  ),
};

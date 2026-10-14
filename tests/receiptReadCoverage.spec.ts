import { describe, expect, it } from 'vitest';
import { projectWorkReceiptDetail, RECEIPT_OPERATION_OUTPUT_SCHEMAS } from '../src/receiptOperationTools';
import { receiptIdempotencyKeySchema } from '../src/idempotencyKeySchema';

describe('bounded receipt read coverage', () => {
  it.each([11,12,13])('discloses evidence cap at %i items without implying full source history', (count) => {
    const r=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({ receipt:{schema_version:'agent-work-receipt/v0.2',receipt_id:'synthetic',intent:{summary:'Synthetic check'},evidence:Array.from({length:count},(_,i)=>({id:`e${i}`}))} }));
    expect(r.coverage?.sections.evidence).toEqual({total:count,returned:Math.min(count,12),limit:12,truncated:count>12});
    expect(r.coverage?.source_coverage).toBe('unknown'); expect(r.coverage?.continuation).toBe('unsupported');
    expect(r.coverage?.status).toBe(count>12?'partial':'unknown');
  });
  it('reports every direct and review-section cap while preserving separate human judgment', () => {
    const make=(n:number)=>Array.from({length:n},(_,i)=>({id:`e${i}`}));
    const result=projectWorkReceiptDetail({receipt_review_revision:'revision-2',human_judgment:{outcome_status:'blocked',actor_id:'reviewer',decided_at:'2026-10-14T10:00:00Z'},
      mappings:make(11),links:make(21),uncertain:make(21).map((e)=>e.id),receipt:{schema_version:'agent-work-receipt/v0.2',receipt_id:'synthetic',intent:{criteria:make(41)},evidence:make(13),extensions:{'org.orgx.review/v1':{sources:make(21),criteria:make(21),episodes:make(21)}}}});
    const parsed=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(result);
    expect(parsed.coverage?.omitted).toHaveLength(8); expect(parsed.human_judgment?.outcome_status).toBe('blocked');
    expect(parsed.producer_claims.outcome_status).toBeNull();expect(parsed.receipt_review_revision).toBe('revision-2');
  });
  it('pins the Trail @ key incompatibility without submitting or widening the contract', () => {
    const fingerprint='a'.repeat(64),legacy=`trail:synthetic:T1@${fingerprint}`;
    expect(receiptIdempotencyKeySchema.safeParse(legacy).success).toBe(false);
    expect(receiptIdempotencyKeySchema.safeParse(`trail:synthetic:T1:${fingerprint}`).success).toBe(true);
  });
  it('discloses nested evidence/source caps and character clipping without returning omitted text', () => {
    const evidence_ids=Array.from({length:21},(_,i)=>`e${i}`),source_refs=Array.from({length:6},(_,i)=>({source_id:`s${i}`}));
    const raw={schema_version:'agent-work-receipt/v0.2',receipt_id:'synthetic',intent:{objective:'x'.repeat(2001),criteria:[{id:'c1',text:'Test'}]},outcome:{criteria_results:[{criterion_id:'c1',evidence_ids}]},extensions:{'org.orgx.review/v1':{criteria:[{criterion_id:'c1',source_refs,lenses:{measured:{evidence_ids}}}]}}};
    const parsed=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({receipt:raw}));
    expect(parsed.coverage?.sections.review_criteria_0_sources).toMatchObject({total:6,returned:5,truncated:true});
    expect(parsed.coverage?.sections.criteria_0_evidence.truncated).toBe(true);
    expect(parsed.coverage?.clipped_fields).toContainEqual({path:'/objective',original_characters:2001,limit:2000,unit:'utf16_code_unit'});
  });
  it('counts proof label clipping after the renderer trims its input', () => {
    const result=projectWorkReceiptDetail({receipt:{schema_version:'agent-work-receipt/v0.2',receipt_id:'synthetic',evidence:[{id:'e1',summary:' '.repeat(280)+'x'}]}});
    const parsed=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(result);
    expect(parsed.proof.evidence[0].label).toBe('x');
    expect(parsed.coverage?.clipped_fields.some((f)=>f.path==='/proof/evidence/0/label')).toBe(false);
  });
});

import { nextOccurrence, occurrencesBetween, describe } from "../recurrence.js";
import assert from "node:assert/strict";
const at = s => Date.parse(s + ":00+05:30");
const n = (a, s) => nextOccurrence(a, at(s));
const cases = {
  once: () => { const a={type:"ONCE",date:"2026-11-20",hour:9,minute:15}; assert.equal(n(a,"2026-11-14T13:00"),at("2026-11-20T09:15")); assert.equal(n(a,"2026-11-20T09:15"),null); },
  daily: () => { const a={type:"DAILY",hour:7,minute:0,startDate:"2026-11-01"}; assert.equal(n(a,"2026-11-14T07:00"),at("2026-11-15T07:00")); },
  weekdays: () => { const a={type:"WEEKDAYS",weekdays:[1,3,5],hour:18,minute:30,startDate:"2026-11-01"}; assert.equal(n(a,"2026-11-14T12:00"),at("2026-11-16T18:30")); },
  twoWeeks: () => { const a={type:"INTERVAL",interval:2,intervalUnit:"WEEKS",hour:10,minute:0,startDate:"2026-12-01"}; assert.equal(n(a,"2026-12-01T10:00"),at("2026-12-15T10:00")); },
  monthly31: () => { const a={type:"MONTHLY",dayOfMonth:31,hour:9,minute:0,startDate:"2026-11-01"}; assert.equal(n(a,"2026-11-14T00:00"),at("2026-11-30T09:00")); assert.equal(n(a,"2027-01-31T09:00"),at("2027-02-28T09:00")); },
  lastDayLeap: () => { const a={type:"MONTHLY",dayOfMonth:-1,hour:9,minute:0,startDate:"2028-01-01"}; assert.equal(n(a,"2028-02-01T00:00"),at("2028-02-29T09:00")); },
  maxCount: () => { const a={type:"DAILY",hour:7,minute:0,startDate:"2026-11-10",maxCount:5}; assert.equal(n(a,"2026-11-14T07:00"),null); },
  min15: () => { const a={type:"INTERVAL",interval:15,intervalUnit:"MINUTES",hour:9,minute:0,startDate:"2026-11-14"}; assert.equal(n(a,"2026-11-14T13:05"),at("2026-11-14T13:15")); },
  hours2: () => { const a={type:"INTERVAL",interval:2,intervalUnit:"HOURS",hour:8,minute:0,startDate:"2026-11-14",endDate:"2026-11-14"}; assert.equal(n(a,"2026-11-14T21:00"),at("2026-11-14T22:00")); assert.equal(n(a,"2026-11-14T22:00"),null); },
  between: () => { const a={type:"INTERVAL",interval:30,intervalUnit:"MINUTES",hour:0,minute:0,startDate:"2026-01-01"}; assert.equal(occurrencesBetween(a,at("2026-11-14T00:00"),at("2026-11-15T00:00")).length,48); },
  describe: () => assert.equal(describe({type:"WEEKDAYS",weekdays:[5,1,3],hour:18,minute:30}),"Mon, Wed, Fri at 18:30"),
};
let f=0; for (const [k,fn] of Object.entries(cases)) { try { fn(); console.log("PASS",k);} catch(e){ f++; console.log("FAIL",k,e.message);} }
console.log(f?f+" FAILED":"ALL PASSED"); process.exit(f?1:0);

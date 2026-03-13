---
name: TDD
description: Test-driven development with red-green-refactor discipline. DEFAULT for all implementation work. Skip only when explicitly told to avoid TDD.
key: tdd
include_when: Any implementation work — features, bug fixes, refactoring. Default ON. Exclude only when user explicitly opts out or when tests don't make sense given the context.
---

# TDD Skill

Write tests first. Each test verifies one behavior through the public interface. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists.

**Test behavior, not implementation.** If you refactor internals and behavior is unchanged, every test must stay green. If a test breaks on refactor, it was testing implementation — delete it and write a better one.

List the **behaviors** to test, not the implementation steps. Think "what should the system do?" not "what functions do I need?"

```pseudocode
// Good: tests observable behavior
test("user can checkout with valid cart")
  cart = createCart()
  cart.add(product)
  result = checkout(cart, paymentMethod)
  assert result.status == "confirmed"

// Bad: tests implementation coupling
test("checkout calls paymentService.process")
  mockPayment = mock(paymentService)
  checkout(cart, payment)
  assert mockPayment.process.wasCalledWith(cart.total)
```

Red flags that a test is coupled to implementation:

- Mocks internal collaborators (not system boundaries)
- Tests private methods
- Asserts on call counts or ordering
- Breaks when refactoring without behavior change
- Verifies through external means instead of the interface

```pseudocode
// Bad: bypasses interface to verify
test("createUser saves to database")
  createUser({ name: "Alice" })
  row = db.query("SELECT * FROM users WHERE name = ?", ["Alice"])
  assert row exists

// Good: verifies through interface
test("created user is retrievable")
  user = createUser({ name: "Alice" })
  retrieved = getUser(user.id)
  assert retrieved.name == "Alice"
```

## Anti-Pattern: Horizontal Slicing

**DO NOT write all tests first, then all implementation.**

This is the single most common AI agent failure mode. Horizontal slicing — treating RED as "write all tests" and GREEN as "write all code" — produces garbage tests:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You test data structures and function signatures instead of user-facing behavior
- Tests become insensitive to real changes: pass when behavior breaks, fail when behavior is fine
- You commit to test structure before understanding the implementation

**Correct approach: vertical slices.**

```pseudocode
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED->GREEN: test1 -> impl1
  RED->GREEN: test2 -> impl2
  RED->GREEN: test3 -> impl3
```

After each GREEN, decide the next test based on what you just learned about the code. Each cycle informs the next.

### Tracer Bullet

The first vertical slice is the **tracer bullet** — one test that proves the end-to-end path works. Subsequent tests are incremental, each responding to what you learned from the previous cycle.

Rules:

- One test at a time
- Only enough code to pass the current test
- Don't anticipate future tests
- Never refactor while RED — get to GREEN first

## Mock Boundaries

Mock at **system boundaries** only:

| Mock                                     | Don't Mock             |
| ---------------------------------------- | ---------------------- |
| External APIs (payment, email)           | Your own modules       |
| Databases (prefer test DB when feasible) | Internal collaborators |
| Time / randomness                        | Anything you control   |
| Network / file system (when necessary)   |                        |

Design boundary interfaces for mockability — accept dependencies, don't create them internally.

```pseudocode
// Mockable: dependency is injected
processPayment(order, paymentClient)
  return paymentClient.charge(order.total)

// Not mockable: dependency is created internally
processPayment(order)
  client = new StripeClient(env.STRIPE_KEY)
  return client.charge(order.total)
```

## Per-Cycle Gate

BEFORE moving to the next cycle, confirm ALL of these hold:

- Test describes behavior, not implementation
- Test uses public interface only
- Test would survive an internal refactor
- Code is minimal for this test — no speculative features
- No mocks of internal collaborators

## Scope

**You can't test everything.** Focus on critical paths and complex logic, not every edge case. When planning, identify the behaviors that matter most and test those.

The Engineer agent handles Red-Green-Refactor cycle mechanics and test priority ordering. This skill guides **what** and **how** to test; the Engineer handles the execution loop.

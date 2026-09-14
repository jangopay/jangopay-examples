<p align="center"><img src="assets/brand-banner-en.png" alt="JangoPay — stablecoin payments for global online businesses" width="100%"></p>

<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="https://www.jangopay.org/">Website</a> · <a href="mailto:contact@jangopay.org">Contact</a></p>

# JangoPay Integration Recipes

**Practical workflows for online businesses.**

This repository provides merchant workflow recipes and a reusable launch checklist. It is **not an SDK** and does not include unverified JangoPay endpoints or executable payment requests.

## Recipes

| Workflow | Best for | Read |
| :--- | :--- | :--- |
| Payment link | A quick launch without a custom integration | [English](recipes/workflows.en.md#payment-link) · [中文](recipes/workflows.zh-CN.md#收款链接) |
| Digital delivery | Content access, licenses and downloads after confirmed payment | [English](recipes/workflows.en.md#digital-delivery) · [中文](recipes/workflows.zh-CN.md#数字交付) |
| Service renewal | SaaS, hosting and other service renewals | [English](recipes/workflows.en.md#service-renewal) · [中文](recipes/workflows.zh-CN.md#服务续费) |

## Before going live

- [ ] Confirm supported asset/network combinations and applicable fees.
- [ ] Map merchant orders to payment records.
- [ ] Verify notifications using the official documented method.
- [ ] Handle duplicated, delayed and out-of-order notifications safely.
- [ ] Deliver goods or activate services only after verified confirmation.
- [ ] Prepare recovery paths for expired, short, excess or unsupported payments.
- [ ] Keep secrets server-side and redact logs.
- [ ] Reconcile payment and business records before launch.

## Implementation boundary

Any diagrams and steps here describe business workflows, not a published event schema. Use the official API documentation for actual requests, signatures, status values and integrations.

[Product documentation](https://github.com/jangopay/jangopay-docs) · [Website](https://www.jangopay.org/) · [Contact](mailto:contact@jangopay.org)

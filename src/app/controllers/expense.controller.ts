import logger from '../services/logger.service';
import { Response } from 'express';
import { sendError, sendSuccess } from '../shared/helper';
import { CustomRequest } from '../types/custom-request';
import { ExpenseService } from '../services/expense.service';
import { AppError } from '../shared/errors';

// Create a new expense/transaction
// Note: Plan limit enforcement is handled upstream by:
//   verifyAccessToken -> attachPlanContext -> checkPlanLimit('transactions')
export const createExpense = async (req: CustomRequest, res: Response) => {
  try {
    const user = req.user_id || '';
    const expense = await ExpenseService.createExpense(req.body, user, req);
    sendSuccess(res, expense, 'Expense created successfully', 201);
  } catch (error: any) {
    // Propagate AppError subclasses (PlanLimitError, etc.) with correct status code
    if (error instanceof AppError) {
      return sendError(
        res,
        error.message,
        error.statusCode,
        error.code,
        error.details
      );
    }
    sendError(res, error.message);
  }
};

export const getExpenses = async (req: CustomRequest, res: Response) => {
  try {
    const user = req.user_id || '';
    const {
      search,
      category,
      categories,
      type,
      startDate,
      endDate,
      limit,
      skip,
    } = req.query;

    const finalStartDate = startDate as string;
    const finalEndDate = endDate as string;

    // No longer defaulting to current month here to allow fetching all transactions
    // The frontend should specify the dates if it wants them filtered.

    const filters = {
      search: search as string,
      category: category as string,
      categories: categories as string,
      type: type as 'income' | 'outcome',
      startDate: finalStartDate,
      endDate: finalEndDate,
      limit: limit ? parseInt(limit as string) : undefined,
      skip: skip ? parseInt(skip as string) : undefined,
    };

    const expenses = await ExpenseService.getExpenses(user, filters);

    // If filters (especially pagination) are used, return structured response
    // Otherwise return array directly for backward compatibility
    if (filters.limit || filters.skip || filters.type) {
      sendSuccess(res, expenses);
    } else {
      // Return just the data array for simple queries
      sendSuccess(res, expenses.data || expenses);
    }
  } catch (error: any) {
    logger.error('❌ Error in getExpenses:', error);
    sendError(res, error.message);
  }
};

export const getExpenseById = async (req: CustomRequest, res: Response) => {
  try {
    const id = (req.params.id as string) || '';
    const user = req.user_id || '';
    const expense = await ExpenseService.getExpenseById(id, user);
    if (!expense) {
      return sendError(res, 'Expense not found', 404);
    }
    sendSuccess(res, expense);
  } catch (error: any) {
    sendError(res, error.message);
  }
};

export const updateExpense = async (req: CustomRequest, res: Response) => {
  try {
    const id = (req.params.id as string) || '';
    const user = req.user_id || '';
    const updatedExpense = await ExpenseService.updateExpense(
      id,
      req.body,
      user,
      req
    );
    if (!updatedExpense) {
      return sendError(res, 'Expense not found', 404);
    }
    sendSuccess(res, updatedExpense, 'Expense updated successfully');
  } catch (error: any) {
    sendError(res, error.message);
  }
};

export const deleteExpense = async (req: CustomRequest, res: Response) => {
  try {
    const id = (req.params.id as string) || '';
    const user = req.user_id || '';
    const deletedExpense = await ExpenseService.deleteExpense(id, user, req);
    if (!deletedExpense) {
      return sendError(res, 'Expense not found', 404);
    }
    sendSuccess(res, {}, 'Expense deleted successfully');
  } catch (error: any) {
    sendError(res, error.message);
  }
};

export const getExpenseTotals = async (req: CustomRequest, res: Response) => {
  try {
    const user = req.user_id || '';
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return sendError(res, 'Start date and end date are required', 400);
    }
    const result = await ExpenseService.getExpenseTotals(
      user,
      String(startDate),
      String(endDate)
    );
    sendSuccess(res, result);
  } catch (error: any) {
    sendError(res, error.message);
  }
};

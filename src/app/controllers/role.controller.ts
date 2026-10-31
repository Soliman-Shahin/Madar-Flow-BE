import { asError, errorMessage, errorCode } from '../shared/errors';
import { Request, Response } from 'express';
import { sendError, sendSuccess } from '../shared/helper';
import logger from '../services/logger.service';
import { roleService } from '../services/role.service';

// Maps known business-rule error messages thrown by roleService to the
// appropriate HTTP status + error code, instead of defaulting everything to 400.
function mapServiceError(message: string): { status: number; code: string } {
  if (message.includes('not found')) {
    return { status: 404, code: 'NOT_FOUND' };
  }
  if (message.includes('assigned to')) {
    return { status: 409, code: 'CONFLICT' };
  }
  if (
    message.startsWith('Cannot change slug') ||
    message.startsWith('Cannot delete a system role')
  ) {
    return { status: 403, code: 'FORBIDDEN' };
  }
  return { status: 400, code: 'BAD_REQUEST' };
}

class RoleController {
  public getRoles = async (req: Request, res: Response): Promise<void> => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 10;
      const search = (req.query.search as string) || '';
      const sortField = (req.query.sortField as string) || undefined;
      const sortOrderRaw = req.query.sortOrder as string | undefined;
      const sortOrder =
        sortOrderRaw !== undefined ? parseInt(sortOrderRaw, 10) : undefined;

      const result = await roleService.getAllRoles({
        page,
        limit,
        search,
        sortField,
        sortOrder,
      });

      sendSuccess(res, result, 'Roles fetched successfully');
    } catch (error: unknown) {
      logger.error('Error fetching roles:', asError(error));
      sendError(res, errorMessage(error), 500, 'INTERNAL_ERROR');
    }
  };

  public getRoleById = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const role = await roleService.getRoleById(id as string);
      if (!role) {
        sendError(res, 'Role not found', 404, 'NOT_FOUND');
        return;
      }
      sendSuccess(res, role, 'Role fetched successfully');
    } catch (error: unknown) {
      logger.error('Error fetching role:', asError(error));
      sendError(res, errorMessage(error), 500, 'INTERNAL_ERROR');
    }
  };

  public createRole = async (req: Request, res: Response): Promise<void> => {
    try {
      const roleData = req.body;
      const newRole = await roleService.createRole(roleData);
      sendSuccess(res, newRole, 'Role created successfully');
    } catch (error: unknown) {
      logger.error('Error creating role:', asError(error));
      if (errorCode(error) === 11000) {
        sendError(
          res,
          'Role with this name or slug already exists',
          409,
          'CONFLICT'
        );
      } else {
        sendError(res, errorMessage(error), 400, 'BAD_REQUEST');
      }
    }
  };

  public updateRole = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const roleData = req.body;
      const updatedRole = await roleService.updateRole(id as string, roleData);
      if (!updatedRole) {
        sendError(res, 'Role not found', 404, 'NOT_FOUND');
        return;
      }
      sendSuccess(res, updatedRole, 'Role updated successfully');
    } catch (error: unknown) {
      logger.error('Error updating role:', asError(error));
      if (errorCode(error) === 11000) {
        sendError(
          res,
          'Role with this name or slug already exists',
          409,
          'CONFLICT'
        );
        return;
      }
      const { status, code } = mapServiceError(errorMessage(error) || '');
      sendError(res, errorMessage(error), status, code);
    }
  };

  public deleteRole = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      await roleService.deleteRole(id as string);
      sendSuccess(res, null, 'Role deleted successfully');
    } catch (error: unknown) {
      logger.error('Error deleting role:', asError(error));
      const { status, code } = mapServiceError(errorMessage(error) || '');
      sendError(res, errorMessage(error), status, code);
    }
  };
}

export const roleController = new RoleController();
